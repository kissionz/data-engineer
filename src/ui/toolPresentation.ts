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

  if (call.name === "Bash") {
    return `Bash ${compact(String(call.args.command ?? "command"), 100)}`;
  }

  return call.name;
}

export function summarizeApproval(call: ToolCall): string | null {
  if (call.name !== "Edit") {
    return null;
  }

  const oldText = compact(String(call.args.old_string ?? ""), 40);
  const newText = compact(String(call.args.new_string ?? ""), 40);
  return `"${oldText}" -> "${newText}"`;
}

function compact(value: string, maxLength = 100): string {
  const singleLine = value.replace(/\s+/g, " ").trim();

  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 3)}...`;
}
