import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { canonicalHostname } from "../runtime/httpSafety.js";

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const positiveFiniteNumber = z.number().finite().positive();
const nonNegativeFiniteNumber = z.number().finite().nonnegative();
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const networkPort = z.number().int().min(1).max(65_535);
const exactHostname = z.string().min(1).max(253).refine(
  (host) => {
    try {
      return (
        canonicalHostname(host) === host &&
        !host.includes("*") &&
        !host.includes(":") &&
        !host.includes("/")
      );
    } catch {
      return false;
    }
  },
  "must be an exact lowercase canonical hostname",
);

const stdioTransportSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1).max(1_000),
    args: z.array(z.string().max(4_000)).max(128).default([]),
    cwd: z.string().min(1).max(4_000).optional(),
    envAllowlist: z.array(environmentName).max(64).default([]),
  })
  .strict();

const httpTransportSchema = z
  .object({
    type: z.literal("http"),
    url: z.string().url(),
    allowedHosts: z
      .array(exactHostname)
      .min(1)
      .max(32)
      .refine(
        (hosts) => new Set(hosts).size === hosts.length,
        "allowedHosts must not contain duplicates",
      ),
    tokenEnv: environmentName.optional(),
    allowLocalhost: z.boolean().default(false),
  })
  .strict();

const mcpServerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    enabled: z.boolean().default(true),
    transport: z.discriminatedUnion("type", [
      stdioTransportSchema,
      httpTransportSchema,
    ]),
    timeoutMs: positiveInteger.max(300_000).default(30_000),
    maxTools: positiveInteger.max(128).default(64),
    maxResources: positiveInteger.max(256).default(64),
    maxPrompts: positiveInteger.max(128).default(64),
  })
  .strict();

const httpFetchSchema = z
  .object({
    enabled: z.boolean().default(false),
    allowedHosts: z
      .array(exactHostname)
      .max(32)
      .default([])
      .refine(
        (hosts) => new Set(hosts).size === hosts.length,
        "allowedHosts must not contain duplicates",
      ),
    allowedPorts: z.array(networkPort).min(1).max(32).default([443]),
    allowHttpLocalhost: z.boolean().default(false),
    maxRedirects: nonNegativeInteger.max(10).default(3),
    maxResponseBytes: positiveInteger
      .max(4 * 1024 * 1024)
      .default(1_000_000),
    timeoutMs: positiveInteger.max(120_000).default(30_000),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.enabled && config.allowedHosts.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["allowedHosts"],
        message: "enabled HttpFetch requires at least one allowed host",
      });
    }
    if (
      config.allowHttpLocalhost &&
      !config.allowedHosts.includes("localhost")
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowHttpLocalhost"],
        message:
          "allowHttpLocalhost requires localhost in allowedHosts",
      });
    }
  });

const budgetSchema = z
  .object({
    maxTurns: positiveInteger.optional(),
    maxWallTimeMs: positiveInteger.optional(),
    maxInputTokens: positiveInteger.optional(),
    maxOutputTokens: positiveInteger.optional(),
    maxToolCalls: nonNegativeInteger.optional(),
    maxModelRetries: nonNegativeInteger.optional(),
    maxEstimatedCostUsd: positiveFiniteNumber.optional(),
  })
  .strict();

const compactionSchema = z
  .object({
    maxRecentEvents: nonNegativeInteger.max(1_000_000).default(30),
    eventThreshold: nonNegativeInteger.max(1_000_000).default(60),
    fallbackTokenThreshold: positiveInteger
      .max(1_000_000_000)
      .default(24_000),
    contextWindowRatio: z.number().finite().min(0.1).max(0.95).default(0.6),
  })
  .strict();

export const userConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    model: z
      .object({
        provider: z.enum(["openai", "mock"]).optional(),
        name: z.string().min(1).max(200).optional(),
        baseUrl: z.string().url().optional(),
        pricing: z
          .object({
            inputPerMillionTokens: nonNegativeFiniteNumber,
            outputPerMillionTokens: nonNegativeFiniteNumber,
            cacheReadPerMillionTokens:
              nonNegativeFiniteNumber.optional(),
          })
          .strict()
          .optional(),
        capabilities: z
          .object({
            contextWindow: positiveInteger.max(1_000_000_000).optional(),
            maxOutputTokens: positiveInteger.max(1_000_000).optional(),
            supportsStreaming: z.boolean().optional(),
            supportsToolUse: z.boolean().optional(),
            supportsImages: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    budget: budgetSchema.optional(),
    compaction: compactionSchema.optional(),
    memory: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional(),
    telemetry: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional(),
    httpFetch: httpFetchSchema.optional(),
    mcpServers: z.array(mcpServerSchema).max(32).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.budget?.maxEstimatedCostUsd === undefined) {
      return;
    }
    const pricing = config.model?.pricing;
    if (
      !pricing ||
      (pricing.inputPerMillionTokens === 0 &&
        pricing.outputPerMillionTokens === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget", "maxEstimatedCostUsd"],
        message:
          "maxEstimatedCostUsd requires non-zero model pricing.",
      });
    }
  });

export type UserConfig = z.infer<typeof userConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type HttpFetchConfig = z.infer<typeof httpFetchSchema>;

export function defaultUserConfigPath(userHome = homedir()): string {
  return path.join(userHome, ".harness", "config.json");
}

export async function loadUserConfig(
  configPath = defaultUserConfigPath(),
): Promise<UserConfig> {
  let info;
  try {
    info = await lstat(configPath);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return userConfigSchema.parse({});
    }
    throw error;
  }

  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Refusing a symbolic link or non-file user config.");
  }
  if (info.size > 1024 * 1024) {
    throw new Error("User config exceeds the 1 MiB safety limit.");
  }

  const handle = await open(configPath, "r");
  try {
    const [pathInfo, handleInfo] = await Promise.all([
      lstat(configPath),
      handle.stat(),
    ]);
    if (
      pathInfo.isSymbolicLink() ||
      !pathInfo.isFile() ||
      pathInfo.dev !== handleInfo.dev ||
      pathInfo.ino !== handleInfo.ino
    ) {
      throw new Error("User config changed while it was being opened.");
    }
    assertPrivateConfigPermissions(handleInfo);
    const text = await handle.readFile("utf8");
    const config = userConfigSchema.parse(JSON.parse(text) as unknown);
    validateUserConfigSecurity(config);
    return config;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`User config is not valid JSON: ${error.message}`);
    }
    throw error;
  } finally {
    await handle.close();
  }
}

function assertPrivateConfigPermissions(info: {
  uid: number;
  mode: number;
}): void {
  if (process.platform === "win32") {
    return;
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && info.uid !== currentUid) {
    throw new Error("User config must be owned by the current user.");
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error("User config must not be writable by group or others.");
  }
}

function validateUserConfigSecurity(config: UserConfig): void {
  const ids = new Set<string>();

  for (const server of config.mcpServers) {
    if (ids.has(server.id)) {
      throw new Error(`Duplicate MCP server id: ${server.id}`);
    }
    ids.add(server.id);

    if (server.transport.type !== "http") {
      if (
        server.transport.cwd !== undefined &&
        !path.isAbsolute(server.transport.cwd)
      ) {
        throw new Error(`MCP server ${server.id} cwd must be absolute.`);
      }
      continue;
    }
    const url = new URL(server.transport.url);
    const hostname = canonicalHostname(url.hostname);
    const allowedHosts = server.transport.allowedHosts;
    const localhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";

    if (url.username || url.password || url.hash) {
      throw new Error(`MCP server ${server.id} URL cannot contain credentials or a fragment.`);
    }
    if (
      url.protocol !== "https:" &&
      !(server.transport.allowLocalhost && localhost && url.protocol === "http:")
    ) {
      throw new Error(
        `MCP server ${server.id} must use HTTPS unless localhost is explicitly allowed.`,
      );
    }
    if (!allowedHosts.includes(hostname)) {
      throw new Error(
        `MCP server ${server.id} hostname is not in its exact allowedHosts list.`,
      );
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
