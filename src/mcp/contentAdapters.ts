import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServerConfig } from "../config/userConfig.js";
import { McpToolAdapter } from "./toolAdapter.js";

const MAX_DISCOVERY_PAGES = 128;
const MAX_DISCOVERY_BYTES = 1024 * 1024;
const MAX_REMOTE_NAME_CHARS = 128;
const MAX_URI_CHARS = 8 * 1024;
const MAX_PROMPT_ARGUMENTS = 128;
const MAX_PROMPT_ARGUMENT_CHARS = 16 * 1024;

interface DiscoveryBudget {
  kind: "resources" | "prompts";
  limit: number;
  remaining: number;
}

export async function discoverContentAdapters(
  client: Client,
  config: McpServerConfig,
): Promise<McpToolAdapter[]> {
  const capabilities = client.getServerCapabilities();
  const adapters: McpToolAdapter[] = [];

  if (capabilities?.resources) {
    adapters.push(...await discoverResourceAdapters(client, config, {
      kind: "resources",
      limit: config.maxResources,
      remaining: config.maxResources,
    }));
  }
  if (capabilities?.prompts) {
    adapters.push(...await discoverPromptAdapters(client, config, {
      kind: "prompts",
      limit: config.maxPrompts,
      remaining: config.maxPrompts,
    }));
  }
  return adapters;
}

async function discoverResourceAdapters(
  client: Client,
  config: McpServerConfig,
  budget: DiscoveryBudget,
): Promise<McpToolAdapter[]> {
  const adapters: McpToolAdapter[] = [];
  const signal = AbortSignal.timeout(config.timeoutMs);
  let cursor: string | undefined;
  let pageCount = 0;
  let discoveryBytes = 0;
  const seenCursors = new Set<string>();

  do {
    pageCount += 1;
    assertPageLimit(config.id, "resource", pageCount);
    const page = await client.listResources(
      cursor ? { cursor } : undefined,
      { signal, timeout: config.timeoutMs },
    );
    discoveryBytes = addDiscoveryBytes(
      config.id,
      "resource",
      discoveryBytes,
      page.resources,
    );

    for (const resource of page.resources) {
      assertRemoteName(config.id, "resource", resource.name);
      if (
        !resource.uri ||
        resource.uri.length > MAX_URI_CHARS ||
        /[\p{Cc}\p{Cf}]/u.test(resource.uri)
      ) {
        throw new Error(
          `MCP server ${config.id} returned an invalid resource URI.`,
        );
      }
      consumeToolBudget(config, budget);
      const uri = resource.uri;
      adapters.push(new McpToolAdapter({
        serverId: config.id,
        remoteName: resource.name,
        wireNameSeed: `resource:${uri}`,
        kind: "resource",
        effect: "readonly",
        timeoutMs: config.timeoutMs,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        caller: {
          callTool: async (_name, _args, options) =>
            resourceResultToToolResult(await client.readResource(
              { uri },
              { signal: options.signal, timeout: options.timeoutMs },
            )),
        },
      }));
    }
    cursor = nextCursor(config.id, "resource", page.nextCursor, seenCursors);
  } while (cursor);

  return adapters;
}

async function discoverPromptAdapters(
  client: Client,
  config: McpServerConfig,
  budget: DiscoveryBudget,
): Promise<McpToolAdapter[]> {
  const adapters: McpToolAdapter[] = [];
  const signal = AbortSignal.timeout(config.timeoutMs);
  let cursor: string | undefined;
  let pageCount = 0;
  let discoveryBytes = 0;
  const seenCursors = new Set<string>();

  do {
    pageCount += 1;
    assertPageLimit(config.id, "prompt", pageCount);
    const page = await client.listPrompts(
      cursor ? { cursor } : undefined,
      { signal, timeout: config.timeoutMs },
    );
    discoveryBytes = addDiscoveryBytes(
      config.id,
      "prompt",
      discoveryBytes,
      page.prompts,
    );

    for (const prompt of page.prompts) {
      assertRemoteName(config.id, "prompt", prompt.name);
      const inputSchema = promptInputSchema(config.id, prompt.arguments);
      consumeToolBudget(config, budget);
      const promptName = prompt.name;
      adapters.push(new McpToolAdapter({
        serverId: config.id,
        remoteName: promptName,
        wireNameSeed: `prompt:${promptName}`,
        kind: "prompt",
        effect: "readonly",
        timeoutMs: config.timeoutMs,
        inputSchema,
        caller: {
          callTool: async (_name, args, options) =>
            promptResultToToolResult(await client.getPrompt(
              {
                name: promptName,
                arguments: args as Record<string, string>,
              },
              { signal: options.signal, timeout: options.timeoutMs },
            )),
        },
      }));
    }
    cursor = nextCursor(config.id, "prompt", page.nextCursor, seenCursors);
  } while (cursor);

  return adapters;
}

function promptInputSchema(
  serverId: string,
  args: Array<{ name: string; required?: boolean }> | undefined,
): Record<string, unknown> {
  const promptArgs = args ?? [];
  if (promptArgs.length > MAX_PROMPT_ARGUMENTS) {
    throw new Error(
      `MCP server ${serverId} returned too many prompt arguments.`,
    );
  }
  const properties: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const required: string[] = [];
  for (const arg of promptArgs) {
    assertRemoteName(serverId, "prompt argument", arg.name);
    if (Object.hasOwn(properties, arg.name)) {
      throw new Error(
        `MCP server ${serverId} repeated a prompt argument name.`,
      );
    }
    properties[arg.name] = {
      type: "string",
      maxLength: MAX_PROMPT_ARGUMENT_CHARS,
    };
    if (arg.required === true) {
      required.push(arg.name);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
    maxProperties: MAX_PROMPT_ARGUMENTS,
  };
}

function resourceResultToToolResult(result: {
  contents: Array<
    { uri: string; mimeType?: string; text: string } |
    { uri: string; mimeType?: string; blob: string }
  >;
}): Record<string, unknown> {
  return {
    content: result.contents.map((content) => ({
      type: "text",
      text:
        `[Untrusted MCP resource uri=${safeLabel(content.uri)} ` +
        `mimeType=${safeLabel(content.mimeType ?? "unknown")}]\n` +
        ("text" in content ? content.text : content.blob),
    })),
  };
}

function promptResultToToolResult(result: {
  messages: Array<{
    role: "user" | "assistant";
    content: Record<string, unknown>;
  }>;
}): Record<string, unknown> {
  return {
    content: result.messages.map((message) => ({
      type: "text",
      text:
        `[Untrusted MCP prompt message role=${message.role}]\n` +
        promptContentText(message.content),
    })),
  };
}

function promptContentText(content: Record<string, unknown>): string {
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  if (
    content.type === "resource" &&
    content.resource &&
    typeof content.resource === "object"
  ) {
    const resource = content.resource as Record<string, unknown>;
    const body =
      typeof resource.text === "string"
        ? resource.text
        : typeof resource.blob === "string"
          ? resource.blob
          : "[MCP embedded resource had no readable content]";
    return (
      `[Embedded resource uri=${safeLabel(String(resource.uri ?? "unknown"))}]\n` +
      body
    );
  }
  return `[MCP ${safeLabel(String(content.type ?? "non-text"))} content omitted]`;
}

function safeLabel(value: string): string {
  return value
    .replaceAll(/[\p{Cc}\p{Cf}\s[\]]+/gu, " ")
    .trim()
    .slice(0, 512);
}

function assertRemoteName(
  serverId: string,
  kind: string,
  name: string,
): void {
  if (
    !name ||
    name.length > MAX_REMOTE_NAME_CHARS ||
    /[\p{Cc}\p{Cf}]/u.test(name)
  ) {
    throw new Error(`MCP server ${serverId} returned an invalid ${kind} name.`);
  }
}

function assertPageLimit(
  serverId: string,
  kind: string,
  pageCount: number,
): void {
  if (pageCount > MAX_DISCOVERY_PAGES) {
    throw new Error(`MCP server ${serverId} returned too many ${kind} pages.`);
  }
}

function addDiscoveryBytes(
  serverId: string,
  kind: string,
  current: number,
  value: unknown,
): number {
  const total =
    current + Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  if (total > MAX_DISCOVERY_BYTES) {
    throw new Error(
      `MCP server ${serverId} ${kind} metadata exceeds 1 MiB.`,
    );
  }
  return total;
}

function consumeToolBudget(
  config: McpServerConfig,
  budget: DiscoveryBudget,
): void {
  if (budget.remaining <= 0) {
    throw new Error(
      `MCP server ${config.id} exposes more than ${budget.limit} ${budget.kind}.`,
    );
  }
  budget.remaining -= 1;
}

function nextCursor(
  serverId: string,
  kind: string,
  cursor: string | undefined,
  seen: Set<string>,
): string | undefined {
  if (cursor) {
    if (seen.has(cursor)) {
      throw new Error(
        `MCP server ${serverId} repeated a ${kind} pagination cursor.`,
      );
    }
    seen.add(cursor);
  }
  return cursor;
}
