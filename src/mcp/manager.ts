import { lookup } from "node:dns/promises";
import { lookup as lookupCallback, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, type Dispatcher } from "undici";
import type { McpServerConfig } from "../config/userConfig.js";
import {
  McpToolAdapter,
  type McpToolCaller,
} from "./toolAdapter.js";

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

const blockedAddresses = createBlockedAddressList();

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
  const transport =
    config.transport.type === "stdio"
      ? createStdioTransport(config.transport)
      : httpSetup!.transport;
  const cleanup = httpSetup?.cleanup ?? (async () => undefined);

  try {
    await client.connect(transport, {
      timeout: config.timeoutMs,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }

  try {
    const tools = await discoverTools(client, config);
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
      tools: tools.map(
        (tool) =>
          new McpToolAdapter({
            serverId: config.id,
            remoteName: tool.name,
            inputSchema: tool.inputSchema,
            timeoutMs: config.timeoutMs,
            caller,
          }),
      ),
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
  transport: StreamableHTTPClientTransport;
  cleanup: () => Promise<void>;
}> {
  const url = new URL(transportConfig.url);
  await assertNetworkDestination(url, transportConfig.allowLocalhost);
  const token = transportConfig.tokenEnv
    ? process.env[transportConfig.tokenEnv]
    : undefined;
  if (transportConfig.tokenEnv && !token) {
    throw new Error(
      `MCP server ${serverId} requires environment variable ${transportConfig.tokenEnv}.`,
    );
  }
  const allowedHosts = new Set(
    transportConfig.allowedHosts.map((host) => host.toLowerCase()),
  );
  const dispatcher = new Agent({
    connect: {
      lookup: secureLookup(transportConfig.allowLocalhost),
    },
    maxResponseSize: 2 * 1024 * 1024,
  });
  const secureFetch: typeof fetch = async (input, init) => {
    const target = new URL(
      input instanceof Request ? input.url : String(input),
    );
    if (
      !allowedHosts.has(target.hostname.toLowerCase()) ||
      target.protocol !== url.protocol
    ) {
      throw new Error("MCP HTTP request attempted to leave its host allowlist.");
    }
    await assertNetworkDestination(target, transportConfig.allowLocalhost);
    const headers = new Headers(init?.headers);
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return fetch(target, {
      ...init,
      headers,
      redirect: "manual",
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
  };

  return {
    transport: new StreamableHTTPClientTransport(url, {
      fetch: secureFetch,
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 5_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 2,
      },
    }),
    cleanup: () => dispatcher.close(),
  };
}

function secureLookup(allowLocalhost: boolean) {
  return (
    hostname: string,
    options: {
      family?: number | "IPv4" | "IPv6";
      hints?: number;
      all?: boolean;
    },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    lookupCallback(
      hostname,
      {
        ...options,
        all: true,
      },
      (error, addresses) => {
        if (error) {
          callback(error, []);
          return;
        }
        const localhostAllowed =
          allowLocalhost && isLocalhostHostname(hostname);
        if (
          addresses.length === 0 ||
          (!localhostAllowed &&
            addresses.some(({ address }) => isPrivateIp(address)))
        ) {
          const denied = new Error(
            "MCP HTTP socket lookup resolved to a private or unavailable address.",
          ) as NodeJS.ErrnoException;
          denied.code = "EACCES";
          callback(denied, []);
          return;
        }
        if (options.all) {
          callback(null, addresses);
        } else {
          const selected = addresses[0]!;
          callback(null, selected.address, selected.family);
        }
      },
    );
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
  const localhost = isLocalhostHostname(url.hostname);
  if (localhost) {
    if (!allowLocalhost) {
      throw new Error("MCP localhost access requires allowLocalhost=true.");
    }
    return;
  }

  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("MCP HTTP hostname resolves to a private or unavailable address.");
  }
}

function isLocalhostHostname(hostname: string): boolean {
  return (
    hostname.toLowerCase() === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return blockedAddresses.check(address, "ipv4");
  }
  if (family === 6) {
    return blockedAddresses.check(address, "ipv6");
  }
  return true;
}

function createBlockedAddressList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 96],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}
