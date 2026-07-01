import { createServer } from "node:net";
import {
  chmod,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileOAuthStateStore,
  McpOAuthProvider,
  type OAuthStateStore,
  type StoredOAuthState,
} from "../src/mcp/oauthProvider.js";

class MemoryOAuthStateStore implements OAuthStateStore {
  state: StoredOAuthState = { version: 1 };

  async load(): Promise<StoredOAuthState> {
    return structuredClone(this.state);
  }

  async save(state: StoredOAuthState): Promise<void> {
    this.state = structuredClone(state);
  }
}

describe("MCP OAuth provider", () => {
  it("completes a state-bound loopback authorization and persists tokens", async () => {
    const port = await availablePort();
    const store = new MemoryOAuthStateStore();
    let launched: URL | undefined;
    const provider = new McpOAuthProvider({
      serverId: "oauth_test",
      serverUrl: new URL("https://mcp.example/mcp"),
      allowedHosts: new Set(["mcp.example", "auth.example"]),
      callbackPort: port,
      callbackTimeoutMs: 5_000,
      redirectMode: "browser",
      stateStore: store,
      launchBrowser: async (url) => {
        launched = url;
      },
    });

    try {
      const state = await provider.state();
      await provider.saveCodeVerifier("verifier");
      const untrustedAuthorizationUrl = new URL(
        "https://evil.example/authorize",
      );
      untrustedAuthorizationUrl.searchParams.set("state", state);
      await expect(
        provider.redirectToAuthorization(untrustedAuthorizationUrl),
      ).rejects.toThrow("outside the configured MCP allowlist");

      const authorizationUrl = new URL("https://auth.example/authorize");
      authorizationUrl.searchParams.set("state", state);
      await provider.redirectToAuthorization(authorizationUrl);
      expect(launched?.toString()).toBe(authorizationUrl.toString());

      const codePromise = provider.waitForAuthorizationCode();
      const callback = new URL(provider.redirectUrl);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", state);
      const response = await fetch(callback);

      expect(response.status).toBe(200);
      await expect(codePromise).resolves.toBe("authorization-code");
      expect(await provider.codeVerifier()).toBe("verifier");

      await provider.saveTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "bearer",
      });
      await expect(provider.tokens()).resolves.toMatchObject({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
      await expect(provider.codeVerifier()).rejects.toThrow("unavailable");
    } finally {
      await provider.close();
    }
  });

  it("persists and selectively invalidates OAuth registration state", async () => {
    const store = new MemoryOAuthStateStore();
    const provider = new McpOAuthProvider({
      serverId: "state_test",
      serverUrl: new URL("https://mcp.example/mcp"),
      allowedHosts: new Set(["mcp.example"]),
      callbackPort: 33_419,
      callbackTimeoutMs: 5_000,
      redirectMode: "manual",
      stateStore: store,
    });
    expect(() => provider.waitForAuthorizationCode()).toThrow(
      "was not started",
    );
    await provider.saveClientInformation({ client_id: "client-id" });
    await provider.saveCodeVerifier("verifier");
    await provider.saveTokens({
      access_token: "access-token",
      token_type: "bearer",
    });
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://mcp.example",
    });

    await expect(provider.clientInformation()).resolves.toMatchObject({
      client_id: "client-id",
    });
    await expect(provider.discoveryState()).resolves.toMatchObject({
      authorizationServerUrl: "https://mcp.example",
    });

    await provider.invalidateCredentials("client");
    await expect(provider.clientInformation()).resolves.toBeUndefined();
    await provider.invalidateCredentials("tokens");
    await expect(provider.tokens()).resolves.toBeUndefined();
    await provider.invalidateCredentials("discovery");
    await expect(provider.discoveryState()).resolves.toBeUndefined();
    await provider.invalidateCredentials("all");
    expect(store.state).toEqual({ version: 1 });
  });

  it.runIf(process.platform !== "win32")(
    "stores OAuth state in a private regular file",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-oauth-"));
      const filePath = path.join(root, "state", "server.json");
      const store = new FileOAuthStateStore(filePath);
      await store.save({
        version: 1,
        tokens: {
          access_token: "secret",
          token_type: "bearer",
        },
      });

      const info = await stat(filePath);
      expect(info.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
        version: 1,
        tokens: { access_token: "secret" },
      });
      await expect(store.load()).resolves.toMatchObject({
        tokens: { access_token: "secret" },
      });

      await chmod(filePath, 0o644);
      await expect(store.load()).rejects.toThrow(
        "must not be accessible by other users",
      );
      await chmod(filePath, 0o600);
      await writeFile(filePath, '{"version":2}\n', { mode: 0o600 });
      await expect(store.load()).rejects.toThrow("state is invalid");
    },
  );

  it("returns empty state when no OAuth credential file exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-oauth-"));
    const store = new FileOAuthStateStore(path.join(root, "missing.json"));
    await expect(store.load()).resolves.toEqual({ version: 1 });
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate an OAuth callback port.");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
