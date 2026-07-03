import {
  confirm,
  input,
  select,
} from "@inquirer/prompts";
import { Command } from "commander";
import path from "node:path";
import {
  defaultUserConfigPath,
  loadUserConfig,
  saveUserConfig,
  userConfigSchema,
  type McpServerConfig,
} from "../config/userConfig.js";

type HttpAuthKind = "none" | "bearer" | "oauth";

interface AddOptions {
  config?: string;
  id?: string;
  url?: string;
  auth?: HttpAuthKind;
  tokenEnv?: string;
  allowedHosts?: string[];
  callbackPort?: string;
  manual?: boolean;
  force?: boolean;
  yes?: boolean;
}

interface ConfigOptions {
  config?: string;
}

interface RemoveOptions extends ConfigOptions {
  yes?: boolean;
}

export async function runMcpConfigCommand(
  argv = process.argv.slice(2),
): Promise<boolean> {
  if (argv[0] !== "mcp") {
    return false;
  }

  const program = new Command();
  program
    .name("harness mcp")
    .description("Configure trusted MCP servers without editing JSON");

  program
    .command("add")
    .description("Add a MaxCompute preset or a custom HTTP MCP server")
    .argument("[kind]", "maxcompute or custom")
    .option("--config <path>", "Trusted user config file")
    .option("--id <id>", "MCP server id")
    .option("--url <url>", "Streamable HTTP MCP URL")
    .option("--auth <type>", "Authentication: oauth, bearer, or none")
    .option("--token-env <name>", "Bearer token environment variable")
    .option(
      "--allowed-host <host...>",
      "Exact allowed host names",
    )
    .option("--callback-port <port>", "OAuth loopback callback port")
    .option("--manual", "Print OAuth URL instead of opening a browser")
    .option("--force", "Replace an existing server with the same id")
    .option("--yes", "Require no interactive input")
    .action(async (kind: string | undefined, options: AddOptions) => {
      await addServer(kind, options);
    });

  program
    .command("list")
    .description("List configured MCP servers and the config path")
    .option("--config <path>", "Trusted user config file")
    .action(async (options: ConfigOptions) => {
      await listServers(options);
    });

  program
    .command("remove")
    .description("Remove a configured MCP server")
    .argument("<id>", "MCP server id")
    .option("--config <path>", "Trusted user config file")
    .option("--yes", "Skip confirmation")
    .action(async (id: string, options: RemoveOptions) => {
      await removeServer(id, options);
    });

  await program.parseAsync(["node", "harness-mcp", ...argv.slice(1)]);
  return true;
}

async function addServer(
  requestedKind: string | undefined,
  options: AddOptions,
): Promise<void> {
  const kind = await resolveKind(requestedKind, options.yes === true);
  const configPath = resolveConfigPath(options.config);
  const current = await loadUserConfig(configPath);
  const candidate =
    kind === "maxcompute"
      ? maxComputePreset(options)
      : await customHttpServer(options);
  const parsedServer = parseServer(candidate);
  const existingIndex = current.mcpServers.findIndex(
    (server) => server.id === parsedServer.id,
  );
  if (existingIndex >= 0 && !options.force) {
    if (options.yes) {
      throw new Error(
        `MCP server ${parsedServer.id} already exists; use --force to replace it.`,
      );
    }
    const replace = await confirm({
      message: `MCP server ${parsedServer.id} already exists. Replace it?`,
      default: false,
    });
    if (!replace) {
      console.log("No changes made.");
      return;
    }
  }
  const servers = [...current.mcpServers];
  if (existingIndex >= 0) {
    servers[existingIndex] = parsedServer;
  } else {
    servers.push(parsedServer);
  }
  await saveUserConfig(configPath, {
    ...current,
    mcpServers: servers,
  });
  console.log(`Configured MCP server ${parsedServer.id}.`);
  console.log(`Config: ${configPath}`);
  if (
    parsedServer.transport.type === "http" &&
    parsedServer.transport.auth?.type === "oauth"
  ) {
    console.log("OAuth authorization will start on the next Harness launch.");
  }
}

async function listServers(options: ConfigOptions): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const config = await loadUserConfig(configPath);
  console.log(`Config: ${configPath}`);
  if (config.mcpServers.length === 0) {
    console.log("[No MCP servers configured]");
    return;
  }
  for (const server of config.mcpServers) {
    const transport = server.transport;
    const location =
      transport.type === "http"
        ? transport.url
        : `${transport.command} ${transport.args.join(" ")}`.trim();
    const auth =
      transport.type === "http"
        ? transport.auth?.type ??
          (transport.tokenEnv ? "bearer (legacy)" : "none")
        : "stdio";
    console.log(
      `${server.id}\t${server.enabled ? "enabled" : "disabled"}\t${auth}\t${location}`,
    );
  }
}

async function removeServer(
  id: string,
  options: RemoveOptions,
): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const current = await loadUserConfig(configPath);
  const server = current.mcpServers.find((item) => item.id === id);
  if (!server) {
    throw new Error(`MCP server not found: ${id}`);
  }
  if (!options.yes) {
    const accepted = await confirm({
      message: `Remove MCP server ${id}?`,
      default: false,
    });
    if (!accepted) {
      console.log("No changes made.");
      return;
    }
  }
  await saveUserConfig(configPath, {
    ...current,
    mcpServers: current.mcpServers.filter((item) => item.id !== id),
  });
  console.log(`Removed MCP server ${id}.`);
  console.log(`Config: ${configPath}`);
}

async function resolveKind(
  requested: string | undefined,
  nonInteractive: boolean,
): Promise<"maxcompute" | "custom"> {
  if (requested === "maxcompute" || requested === "custom") {
    return requested;
  }
  if (requested) {
    throw new Error("MCP kind must be maxcompute or custom.");
  }
  if (nonInteractive) {
    throw new Error("Specify maxcompute or custom when using --yes.");
  }
  return select({
    message: "What do you want to configure?",
    choices: [
      {
        name: "MaxCompute Remote MCP",
        value: "maxcompute" as const,
      },
      {
        name: "Custom Streamable HTTP MCP",
        value: "custom" as const,
      },
    ],
  });
}

function maxComputePreset(options: AddOptions): Record<string, unknown> {
  const url =
    options.url ??
    "https://mcp.cn-hangzhou.maxcompute.aliyun.com/mcp";
  return {
    id: options.id ?? "maxcompute",
    enabled: true,
    transport: {
      type: "http",
      url,
      allowedHosts:
        options.allowedHosts ??
        [new URL(url).hostname.toLowerCase()],
      auth: {
        type: "oauth",
        redirectMode: options.manual ? "manual" : "browser",
        ...(options.callbackPort
          ? { callbackPort: parsePort(options.callbackPort) }
          : {}),
      },
    },
    timeoutMs: 30_000,
    maxTools: 128,
    maxResources: 64,
    maxPrompts: 64,
  };
}

async function customHttpServer(
  options: AddOptions,
): Promise<Record<string, unknown>> {
  const nonInteractive = options.yes === true;
  const id =
    options.id ??
    (nonInteractive
      ? requiredOption("--id")
      : await input({
          message: "Server id:",
          validate: (value) =>
            /^[a-z][a-z0-9_-]{0,31}$/.test(value) ||
            "Use lowercase letters, numbers, _ or -; start with a letter.",
        }));
  const urlValue =
    options.url ??
    (nonInteractive
      ? requiredOption("--url")
      : await input({
          message: "Streamable HTTP URL:",
          validate: (value) => validUrl(value) || "Enter a valid URL.",
        }));
  const url = new URL(urlValue);
  const auth =
    options.auth ??
    (nonInteractive
      ? requiredOption("--auth")
      : await select<HttpAuthKind>({
          message: "Authentication:",
          choices: [
            { name: "OAuth (browser login)", value: "oauth" },
            { name: "Bearer token from environment", value: "bearer" },
            { name: "None", value: "none" },
          ],
        }));
  if (!["none", "bearer", "oauth"].includes(auth)) {
    throw new Error("--auth must be oauth, bearer, or none.");
  }
  const allowedHosts =
    options.allowedHosts ??
    (nonInteractive
      ? [url.hostname.toLowerCase()]
      : parseHosts(
          await input({
            message: "Allowed hosts (comma-separated):",
            default: url.hostname.toLowerCase(),
          }),
        ));
  let authConfig: Record<string, unknown>;
  if (auth === "bearer") {
    const tokenEnv =
      options.tokenEnv ??
      (nonInteractive
        ? requiredOption("--token-env")
        : await input({
            message: "Token environment variable:",
            default: "MCP_ACCESS_TOKEN",
          }));
    authConfig = { type: "bearer", tokenEnv };
  } else if (auth === "oauth") {
    const callbackPort = options.callbackPort
      ? parsePort(options.callbackPort)
      : nonInteractive
        ? 33_418
        : Number.parseInt(
            await input({
              message: "OAuth callback port:",
              default: "33418",
              validate: (value) => validPort(value) || "Use port 1024-65535.",
            }),
            10,
          );
    authConfig = {
      type: "oauth",
      redirectMode: options.manual ? "manual" : "browser",
      callbackPort,
    };
  } else {
    authConfig = { type: "none" };
  }
  return {
    id,
    enabled: true,
    transport: {
      type: "http",
      url: url.toString(),
      allowedHosts,
      auth: authConfig,
      allowLocalhost:
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(url.hostname),
    },
  };
}

function parseServer(value: unknown): McpServerConfig {
  const parsed = userConfigSchema.parse({
    version: 1,
    mcpServers: [value],
  });
  const server = parsed.mcpServers[0];
  if (!server) {
    throw new Error("MCP server configuration is missing.");
  }
  return server;
}

function resolveConfigPath(option: string | undefined): string {
  return path.resolve(
    option ??
      process.env.HARNESS_CONFIG ??
      defaultUserConfigPath(),
  );
}

function requiredOption(name: string): never {
  throw new Error(`${name} is required with --yes.`);
}

function parseHosts(value: string): string[] {
  return value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function parsePort(value: string): number {
  if (!validPort(value)) {
    throw new Error("--callback-port must be an integer from 1024 to 65535.");
  }
  return Number.parseInt(value, 10);
}

function validPort(value: string): boolean {
  const parsed = Number.parseInt(value, 10);
  return (
    Number.isInteger(parsed) &&
    String(parsed) === value.trim() &&
    parsed >= 1_024 &&
    parsed <= 65_535
  );
}

function validUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
