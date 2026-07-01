import type { LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, type Dispatcher } from "undici";
import type { McpServerConfig } from "../config/userConfig.js";
import {
  assertAllowedAddress,
  canonicalHostname,
  isLoopback,
  resolveHost,
  type LookupAddress,
} from "../runtime/httpSafety.js";
import {
  McpToolAdapter,
  type McpToolCaller,
} from "./toolAdapter.js";
import { discoverContentAdapters } from "./contentAdapters.js";
import { McpOAuthProvider } from "./oauthProvider.js";

interface McpConnection {
  config: McpServerConfig;
  client: Client;
  tools: McpToolAdapter[];
  cleanup: () => Promise<void>;
}

type StdioTransportConfig = Extract<
  McpServerConfig["transport"],
  { type: "stdio" }
>;
type HttpTransportConfig = Extract<
  McpServerConfig["transport"],
  { type: "http" }
>;

export class McpManager {
  private readonly connections: McpConnection[] = [];

  get tools(): readonly McpToolAdapter[] {
    return this.connections.flatMap((connection) => connection.tools);
  }

  async start(configs: McpServerConfig[]): Promise<void> {
    try {
      for (const config of configs) {
        if (config.enabled) {
          this.connections.push(await connectServer(config));
        }
      }
      const names = this.tools.map((tool) => tool.name);
      if (new Set(names).size !== names.length) {
        throw new Error("MCP tool wire-name collision detected.");
      }
    } catch (error: unknown) {
      await this.closeAll();
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    const connections = this.connections.splice(0).reverse();
    await Promise.allSettled(
      connections.map(async (connection) => {
        try {
          await connection.client.close();
        } finally {
          await connection.cleanup();
        }
      }),
    );
  }
}

async function connectServer(config: McpServerConfig): Promise<McpConnection> {
  const client = new Client({
    name: "harness-ts",
    version: "0.1.0",
  });
  const httpSetup =
    config.transport.type === "http"
      ? await createHttpTransport(config.id, config.transport)
      : undefined;
  let transport =
    config.transport.type === "stdio"
      ? createStdioTransport(config.transport)
      : httpSetup!.createTransport();
  const cleanup = httpSetup?.cleanup ?? (async () => undefined);

  try {
    try {
      await client.connect(transport, {
        timeout: config.timeoutMs,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error: unknown) {
      if (
        !(error instanceof UnauthorizedError) ||
        !httpSetup?.oauthProvider ||
        !(transport instanceof StreamableHTTPClientTransport)
      ) {
        throw error;
      }
      const authorizationCode =
        await httpSetup.oauthProvider.waitForAuthorizationCode();
      await transport.finishAuth(authorizationCode);
      await transport.close().catch(() => undefined);
      transport = httpSetup.createTransport();
      await client.connect(transport, {
        timeout: config.timeoutMs,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    }
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }

  try {
    const capabilities = client.getServerCapabilities();
    const tools = capabilities?.tools
      ? await discoverTools(client, config)
      : [];
    const contentAdapters = await discoverContentAdapters(client, config);
    const caller: McpToolCaller = {
      callTool: async (name, args, options) =>
        client.callTool(
          { name, arguments: args },
          undefined,
          {
            signal: options.signal,
            timeout: options.timeoutMs,
          },
        ),
    };
    return {
      config,
      client,
      cleanup,
      tools: [
        ...tools.map(
          (tool) =>
            new McpToolAdapter({
              serverId: config.id,
              remoteName: tool.name,
              inputSchema: tool.inputSchema,
              timeoutMs: config.timeoutMs,
              caller,
            }),
        ),
        ...contentAdapters,
      ],
    };
  } catch (error: unknown) {
    await client.close().catch(() => undefined);
    await cleanup().catch(() => undefined);
    throw error;
  }
}

function createStdioTransport(
  transportConfig: StdioTransportConfig,
): StdioClientTransport {
  const env = getDefaultEnvironment();
  for (const name of transportConfig.envAllowlist) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  const transport = new StdioClientTransport({
    command: transportConfig.command,
    args: transportConfig.args,
    env,
    cwd: transportConfig.cwd ?? homedir(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {
    // Drain stderr so a noisy server cannot block on a full pipe.
  });
  return transport;
}

async function createHttpTransport(
  serverId: string,
  transportConfig: HttpTransportConfig,
): Promise<{
  createTransport: () => StreamableHTTPClientTransport;
  oauthProvider?: McpOAuthProvider;
  cleanup: () => Promise<void>;
}> {
  const url = new URL(transportConfig.url);
  await assertNetworkDestination(url, transportConfig.allowLocalhost);
  const auth =
    transportConfig.auth ??
    (transportConfig.tokenEnv
      ? { type: "bearer" as const, tokenEnv: transportConfig.tokenEnv }
      : { type: "none" as const });
  const token = auth.type === "bearer"
    ? process.env[auth.tokenEnv]
    : undefined;
  if (auth.type === "bearer" && !token) {
    throw new Error(
      `MCP server ${serverId} requires environment variable ${auth.tokenEnv}.`,
    );
  }
  const oauthProvider =
    auth.type === "oauth"
      ? new McpOAuthProvider({
          serverId,
          serverUrl: url,
          allowedHosts: new Set(transportConfig.allowedHosts),
          callbackPort: auth.callbackPort,
          callbackTimeoutMs: auth.callbackTimeoutMs,
          redirectMode: auth.redirectMode,
        })
      : undefined;
  const allowedHosts = new Set(
    transportConfig.allowedHosts,
  );
  const dispatcher = new Agent({
    connect: {
      lookup: secureLookup(transportConfig.allowLocalhost),
    },
    maxResponseSize: 2 * 1024 * 1024,
  });
  const secureFetch: typeof fetch = async (input, init) => {
    const validated = validateMcpHttpRequestTarget(
      url,
      allowedHosts,
      input instanceof Request ? input.url : String(input),
    );
    const target = validated.url;
    await assertNetworkDestination(target, transportConfig.allowLocalhost);
    const headers = applyMcpHttpAuthorization(
      new Headers(init?.headers),
      auth.type,
      token,
      validated.includeCredential,
    );
    return fetch(target, {
      ...init,
      headers,
      redirect: "manual",
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
  };

  return {
    createTransport: () =>
      new StreamableHTTPClientTransport(url, {
        fetch: secureFetch,
        ...(oauthProvider ? { authProvider: oauthProvider } : {}),
        reconnectionOptions: {
          initialReconnectionDelay: 500,
          maxReconnectionDelay: 5_000,
          reconnectionDelayGrowFactor: 2,
          maxRetries: 2,
        },
      }),
    oauthProvider,
    cleanup: async () => {
      await oauthProvider?.close();
      await dispatcher.close();
    },
  };
}

export function applyMcpHttpAuthorization(
  headers: Headers,
  authType: "none" | "bearer" | "oauth",
  bearerToken: string | undefined,
  includeCredential: boolean,
): Headers {
  if (authType === "bearer" && bearerToken && includeCredential) {
    headers.set("authorization", `Bearer ${bearerToken}`);
  } else if (authType !== "oauth") {
    headers.delete("authorization");
  }
  return headers;
}

export function validateMcpHttpRequestTarget(
  configuredUrl: URL,
  allowedHosts: ReadonlySet<string>,
  input: string,
): { url: URL; includeCredential: boolean } {
  const target = new URL(input);
  const targetHost = canonicalHostname(target.hostname);
  if (
    target.username ||
    target.password ||
    target.hash ||
    !allowedHosts.has(targetHost) ||
    target.protocol !== configuredUrl.protocol ||
    effectivePort(target) !== effectivePort(configuredUrl)
  ) {
    throw new Error(
      "MCP HTTP request attempted to leave its protocol, host, or port allowlist.",
    );
  }
  target.hostname = targetHost;
  return {
    url: target,
    includeCredential: target.origin === configuredUrl.origin,
  };
}

function secureLookup(allowLocalhost: boolean) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: Parameters<LookupFunction>[2],
  ): void => {
    void (async () => {
      try {
        const canonical = canonicalHostname(hostname);
        const addresses = await resolveHost(canonical);
        const localhostAllowed =
          allowLocalhost && isLocalhostHostname(canonical);
        if (addresses.length === 0) {
          throw new Error("MCP HTTP socket lookup returned no addresses.");
        }
        for (const { address } of addresses) {
          assertAllowedAddress(address, { allowLoopback: localhostAllowed });
        }
        finishLookup(addresses, options, callback);
      } catch (error) {
        const denied = (
          error instanceof Error ? error : new Error(String(error))
        ) as NodeJS.ErrnoException;
        denied.code ??= "EACCES";
        callback(denied, "", 0);
      }
    })();
  };
}

async function discoverTools(
  client: Client,
  config: McpServerConfig,
): Promise<Array<{ name: string; inputSchema: Record<string, unknown> }>> {
  const discovered: Array<{
    name: string;
    inputSchema: Record<string, unknown>;
  }> = [];
  let cursor: string | undefined;
  let schemaBytes = 0;
  let pageCount = 0;
  const seenCursors = new Set<string>();
  const discoverySignal = AbortSignal.timeout(config.timeoutMs);

  do {
    pageCount += 1;
    if (pageCount > 128) {
      throw new Error(`MCP server ${config.id} returned too many tool pages.`);
    }
    const page = await client.listTools(
      cursor ? { cursor } : undefined,
      {
        timeout: config.timeoutMs,
        signal: discoverySignal,
      },
    );
    for (const tool of page.tools) {
      if (
        !tool.name ||
        tool.name.length > 128 ||
        /[\p{Cc}\p{Cf}]/u.test(tool.name)
      ) {
        throw new Error(`MCP server ${config.id} returned an invalid tool name.`);
      }
      schemaBytes += Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8");
      if (schemaBytes > 1024 * 1024) {
        throw new Error(`MCP server ${config.id} schemas exceed 1 MiB.`);
      }
      discovered.push({
        name: tool.name,
        inputSchema: tool.inputSchema,
      });
      if (discovered.length > config.maxTools) {
        throw new Error(
          `MCP server ${config.id} exposes more than ${config.maxTools} tools.`,
        );
      }
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error(
          `MCP server ${config.id} repeated a tool pagination cursor.`,
        );
      }
      seenCursors.add(cursor);
    }
  } while (cursor);

  return discovered;
}

async function assertNetworkDestination(
  url: URL,
  allowLocalhost: boolean,
): Promise<void> {
  const hostname = canonicalHostname(url.hostname);
  const localhost = isLocalhostHostname(hostname);
  if (localhost) {
    if (!allowLocalhost) {
      throw new Error("MCP localhost access requires allowLocalhost=true.");
    }
  }

  const addresses = await resolveHost(hostname);
  if (addresses.length === 0) {
    throw new Error("MCP HTTP hostname resolved to no addresses.");
  }
  for (const { address } of addresses) {
    assertAllowedAddress(address, {
      allowLoopback: allowLocalhost && localhost,
    });
  }
}

function isLocalhostHostname(hostname: string): boolean {
  return canonicalHostname(hostname) === "localhost" || isLoopback(hostname);
}

export function isPrivateIp(address: string): boolean {
  if (isIP(address) === 0) {
    return true;
  }
  try {
    assertAllowedAddress(address, { allowLoopback: false });
    return false;
  } catch {
    return true;
  }
}

function effectivePort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function finishLookup(
  addresses: LookupAddress[],
  options: LookupOptions,
  callback: Parameters<LookupFunction>[2],
): void {
  const requestedFamily =
    options.family === 4 || options.family === "IPv4"
      ? 4
      : options.family === 6 || options.family === "IPv6"
        ? 6
        : undefined;
  const eligible = requestedFamily
    ? addresses.filter(({ family }) => family === requestedFamily)
    : addresses;
  if (eligible.length === 0) {
    callback(
      new Error("DNS returned no address for the requested family."),
      "",
      0,
    );
    return;
  }
  if (options.all) {
    callback(null, eligible);
    return;
  }
  callback(null, eligible[0].address, eligible[0].family);
}
