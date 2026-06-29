import type { ToolCall } from "../agent/types.js";

export function summarizeToolCall(call: ToolCall): string {
  if (call.name === "Read" || call.name === "Write" || call.name === "Edit") {
    return `${call.name} ${compact(String(call.args.file_path ?? "file"))}`;
  }

  if (call.name === "Grep") {
    const pattern = compact(String(call.args.pattern ?? "pattern"), 60);
    const searchPath = compact(String(call.args.path ?? "."));
    return `Grep "${pattern}" in ${searchPath}`;
  }

  if (call.name === "Glob") {
    const pattern = compact(String(call.args.pattern ?? "**/*"), 60);
    const searchPath = compact(String(call.args.path ?? "."));
    return `Glob "${pattern}" in ${searchPath}`;
  }

  if (call.name === "GitStatus") {
    return "Git status";
  }

  if (call.name === "GitDiff") {
    return call.args.staged === true ? "Git diff (staged)" : "Git diff";
  }

  if (call.name === "TodoRead") {
    return "Todo read";
  }

  if (call.name === "TodoWrite") {
    const count = Array.isArray(call.args.todos) ? call.args.todos.length : 0;
    return `Todo update (${count} items)`;
  }

  if (call.name === "SkillList") {
    return "Skill list";
  }

  if (call.name === "SkillLoad") {
    return `Skill load ${compact(String(call.args.name ?? "skill"))}`;
  }

  if (call.name === "Task") {
    const subagent = compact(String(call.args.subagent ?? "subagent"), 40);
    const task = compact(String(call.args.task ?? "task"), 70);
    return `Task ${subagent}: ${task}`;
  }

  if (call.name === "EphemeralTask") {
    const role =
      call.args.role &&
      typeof call.args.role === "object" &&
      !Array.isArray(call.args.role)
        ? call.args.role as Record<string, unknown>
        : undefined;
    const subagent = compact(String(role?.name ?? "subagent"), 40);
    const task = compact(String(call.args.task ?? "task"), 70);
    return `Ephemeral task ${subagent}: ${task}`;
  }

  if (call.name === "Bash") {
    return `Bash ${compact(String(call.args.command ?? "command"), 100)}`;
  }

  if (call.name === "HttpFetch") {
    return `HTTP GET ${safeUrlSummary(call.args.url)}`;
  }

  if (call.name === "MemoryWrite") {
    return `Memory write (${compact(String(call.args.scope ?? "scope"), 20)}/${compact(
      String(call.args.kind ?? "kind"),
      30,
    )})`;
  }

  if (call.name === "MemoryDelete") {
    return `Memory delete ${compact(String(call.args.id ?? "memory"), 60)}`;
  }

  if (call.name.startsWith("mcp_")) {
    return `MCP ${compact(call.name, 64)}`;
  }

  return call.name;
}

export function summarizeApproval(call: ToolCall): string | null {
  if (call.name === "Edit") {
    const oldText = compact(String(call.args.old_string ?? ""), 40);
    const newText = compact(String(call.args.new_string ?? ""), 40);
    return `"${oldText}" -> "${newText}"`;
  }

  if (call.name === "MemoryWrite") {
    return compact(String(call.args.content ?? ""), 300);
  }

  if (call.name === "MemoryDelete") {
    return compact(String(call.args.reason ?? ""), 200);
  }

  if (call.name === "HttpFetch") {
    return safeUrlSummary(call.args.url);
  }

  if (call.name.startsWith("mcp_")) {
    return compact(JSON.stringify(redactSensitiveValues(call.args)), 500);
  }

  return null;
}

function safeUrlSummary(value: unknown): string {
  try {
    const url = new URL(String(value));
    return compact(`${url.protocol}//${url.host}${url.pathname}`, 200);
  } catch {
    return "[invalid URL]";
  }
}

function compact(value: string, maxLength = 100): string {
  const singleLine = value.replace(/\s+/g, " ").trim();

  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 3)}...`;
}

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValues);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      /(?:secret|token|password|passwd|cookie|api[_-]?key|authorization)/i.test(
        key,
      )
        ? "[redacted]"
        : redactSensitiveValues(child),
    ]),
  );
}
