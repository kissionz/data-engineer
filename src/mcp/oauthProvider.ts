import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { acquireFileLock } from "../runtime/fileLock.js";

const MAX_OAUTH_STATE_BYTES = 256 * 1024;
const CALLBACK_PATH = "/oauth/callback";

export interface StoredOAuthState {
  version: 1;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface OAuthStateStore {
  load(): Promise<StoredOAuthState>;
  save(state: StoredOAuthState): Promise<void>;
}

export interface McpOAuthProviderOptions {
  serverId: string;
  serverUrl: URL;
  allowedHosts: ReadonlySet<string>;
  callbackPort: number;
  callbackTimeoutMs: number;
  redirectMode: "browser" | "manual";
  stateStore?: OAuthStateStore;
  launchBrowser?: (url: URL) => Promise<void>;
}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly store: OAuthStateStore;
  private readonly callback: OAuthLoopbackCallback;
  private readonly serverUrl: URL;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly redirectMode: "browser" | "manual";
  private readonly launchBrowser: (url: URL) => Promise<void>;
  private stateValue?: string;
  private loaded?: Promise<StoredOAuthState>;

  constructor(options: McpOAuthProviderOptions) {
    this.redirectUrl = new URL(
      `http://127.0.0.1:${options.callbackPort}${CALLBACK_PATH}`,
    );
    this.clientMetadata = {
      client_name: "harness-ts",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    this.store =
      options.stateStore ??
      new FileOAuthStateStore(
        defaultOAuthStatePath(options.serverId, options.serverUrl),
      );
    this.callback = new OAuthLoopbackCallback(
      options.callbackPort,
      options.callbackTimeoutMs,
    );
    this.serverUrl = options.serverUrl;
    this.allowedHosts = options.allowedHosts;
    this.redirectMode = options.redirectMode;
    this.launchBrowser = options.launchBrowser ?? openBrowser;
  }

  async state(): Promise<string> {
    this.stateValue = randomBytes(32).toString("base64url");
    return this.stateValue;
  }

  async clientInformation(): Promise<
    OAuthClientInformationMixed | undefined
  > {
    return (await this.load()).clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.update({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens, codeVerifier: undefined });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (
      authorizationUrl.username ||
      authorizationUrl.password ||
      authorizationUrl.hash ||
      authorizationUrl.protocol !== this.serverUrl.protocol ||
      effectivePort(authorizationUrl) !== effectivePort(this.serverUrl) ||
      !this.allowedHosts.has(authorizationUrl.hostname.toLowerCase())
    ) {
      throw new Error(
        "OAuth authorization URL is outside the configured MCP allowlist.",
      );
    }
    const expectedState = this.stateValue;
    const actualState = authorizationUrl.searchParams.get("state");
    if (
      !expectedState ||
      !actualState ||
      !constantTimeEqual(expectedState, actualState)
    ) {
      throw new Error("OAuth authorization URL has an invalid state.");
    }
    await this.callback.start(expectedState);
    console.log(
      `MCP OAuth authorization required. Open this URL:\n${authorizationUrl.toString()}`,
    );
    if (this.redirectMode === "browser") {
      await this.launchBrowser(authorizationUrl).catch(() => undefined);
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) {
      throw new Error("OAuth PKCE code verifier is unavailable.");
    }
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.update({ discoveryState: state });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const current = await this.load();
    const next = { ...current };
    if (scope === "all" || scope === "client") {
      delete next.clientInformation;
    }
    if (scope === "all" || scope === "tokens") {
      delete next.tokens;
    }
    if (scope === "all" || scope === "verifier") {
      delete next.codeVerifier;
    }
    if (scope === "all" || scope === "discovery") {
      delete next.discoveryState;
    }
    await this.persist(next);
  }

  waitForAuthorizationCode(): Promise<string> {
    return this.callback.waitForCode();
  }

  async close(): Promise<void> {
    await this.callback.close();
  }

  private load(): Promise<StoredOAuthState> {
    this.loaded ??= this.store.load();
    return this.loaded;
  }

  private async update(
    patch: Partial<StoredOAuthState>,
  ): Promise<void> {
    const current = await this.load();
    const next = { ...current, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete next[key as keyof StoredOAuthState];
      }
    }
    await this.persist(next);
  }

  private async persist(state: StoredOAuthState): Promise<void> {
    await this.store.save(state);
    this.loaded = Promise.resolve(state);
  }
}

export class FileOAuthStateStore implements OAuthStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredOAuthState> {
    try {
      const info = await lstat(this.filePath);
      assertPrivateRegularFile(info, this.filePath);
      if (info.size > MAX_OAUTH_STATE_BYTES) {
        throw new Error("MCP OAuth state exceeds the safety limit.");
      }
      const handle = await open(this.filePath, "r");
      try {
        const opened = await handle.stat();
        if (
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          !opened.isFile()
        ) {
          throw new Error("MCP OAuth state changed while being opened.");
        }
        const value = JSON.parse(await handle.readFile("utf8")) as unknown;
        return parseStoredState(value);
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        return { version: 1 };
      }
      throw error;
    }
  }

  async save(state: StoredOAuthState): Promise<void> {
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_OAUTH_STATE_BYTES) {
      throw new Error("MCP OAuth state exceeds the safety limit.");
    }
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error("MCP OAuth state directory is unsafe.");
    }
    if (process.platform !== "win32") {
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && directoryInfo.uid !== currentUid) {
        throw new Error(
          "MCP OAuth state directory must be owned by the current user.",
        );
      }
    }
    await chmod(directory, 0o700);
    const release = await acquireFileLock(this.filePath, {
      label: "MCP OAuth state",
    });
    const tempPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await unlink(tempPath).catch(() => undefined);
      await release();
    }
  }
}

class OAuthLoopbackCallback {
  private server?: Server;
  private codePromise?: Promise<string>;
  private resolveCode?: (code: string) => void;
  private rejectCode?: (error: Error) => void;
  private timeout?: NodeJS.Timeout;

  constructor(
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  async start(expectedState: string): Promise<void> {
    if (this.server) {
      return;
    }
    this.codePromise = new Promise<string>((resolve, reject) => {
      this.resolveCode = resolve;
      this.rejectCode = reject;
    });
    this.server = createServer((request, response) => {
      try {
        const url = new URL(
          request.url ?? "/",
          `http://127.0.0.1:${this.port}`,
        );
        if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
          response.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          throw new Error(`OAuth authorization failed: ${error}`);
        }
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (
          !state ||
          !constantTimeEqual(expectedState, state) ||
          !code ||
          code.length > 8_192
        ) {
          throw new Error("OAuth callback is missing a valid code or state.");
        }
        response
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end("Authorization completed. You can close this window.");
        this.resolveCode?.(code);
        void this.close();
      } catch (error: unknown) {
        response
          .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          .end("Authorization failed.");
        this.rejectCode?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        void this.close();
      }
    });
    this.server.on("error", (error) => {
      this.rejectCode?.(error);
      void this.close();
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("listening", resolve);
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1");
    });
    this.timeout = setTimeout(() => {
      this.rejectCode?.(
        new Error("Timed out waiting for MCP OAuth authorization."),
      );
      void this.close();
    }, this.timeoutMs);
  }

  waitForCode(): Promise<string> {
    if (!this.codePromise) {
      throw new Error("MCP OAuth authorization was not started.");
    }
    return this.codePromise;
  }

  async close(): Promise<void> {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

function defaultOAuthStatePath(serverId: string, serverUrl: URL): string {
  const digest = createHash("sha256")
    .update(serverUrl.toString())
    .digest("hex")
    .slice(0, 16);
  return path.join(
    homedir(),
    ".harness",
    "mcp-oauth",
    `${serverId}-${digest}.json`,
  );
}

async function openBrowser(url: URL): Promise<void> {
  const target = url.toString();
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [target] }
      : process.platform === "win32"
        ? {
            executable: "rundll32.exe",
            args: ["url.dll,FileProtocolHandler", target],
          }
        : { executable: "xdg-open", args: [target] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

function parseStoredState(value: unknown): StoredOAuthState {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new Error("MCP OAuth state is invalid.");
  }
  return value as StoredOAuthState;
}

function assertPrivateRegularFile(
  info: { uid: number; mode: number; isFile(): boolean; isSymbolicLink(): boolean },
  filePath: string,
): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Refusing unsafe MCP OAuth state file: ${filePath}`);
  }
  if (process.platform !== "win32") {
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && info.uid !== currentUid) {
      throw new Error("MCP OAuth state must be owned by the current user.");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("MCP OAuth state must not be accessible by other users.");
    }
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function effectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}
