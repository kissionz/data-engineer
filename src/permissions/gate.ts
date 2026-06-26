import path from "node:path";
import type { ToolCall } from "../agent/types.js";
import type { PermissionPolicy } from "./policy.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
}

export class PermissionGate {
  constructor(private readonly policy: PermissionPolicy) {}

  check(call: ToolCall): PermissionCheckResult {
    if (this.policy.deniedTools.has(call.name)) {
      return { decision: "deny", reason: `Tool denied: ${call.name}` };
    }

    if (this.pathDenied(call)) {
      return { decision: "deny", reason: "Path is denied by policy." };
    }

    if (call.name === "Bash" && this.commandReferencesDeniedPath(call)) {
      return { decision: "deny", reason: "Command references a denied path." };
    }

    if (call.name === "Bash" && this.dangerousCommand(call)) {
      return {
        decision: "deny",
        reason: "Dangerous shell command denied by policy.",
      };
    }

    if (this.policy.allowedTools.has(call.name)) {
      return { decision: "allow", reason: "Tool explicitly allowed." };
    }

    if (this.policy.allowReadonly && ["Read", "Grep"].includes(call.name)) {
      return { decision: "allow", reason: "Readonly tool." };
    }

    if (call.name === "Edit" && this.policy.askForWrite) {
      return {
        decision: "ask",
        reason: "Updating an existing file requires approval.",
      };
    }

    if (call.name === "Bash" && this.readonlyCommand(call)) {
      return { decision: "allow", reason: "Readonly shell command." };
    }

    if (call.name === "Bash" && this.policy.askForBash) {
      return { decision: "ask", reason: "Bash command requires approval." };
    }

    return { decision: "ask", reason: "Default ask." };
  }

  private pathDenied(call: ToolCall): boolean {
    const maybePath = call.args.file_path ?? call.args.path ?? call.args.cwd ?? "";
    const normalized = normalizePolicyPath(String(maybePath));
    const segments = normalized.split("/").filter(Boolean);

    return segments.some(
      (segment) =>
        segment === ".git" ||
        segment === "node_modules" ||
        segment === ".env" ||
        segment.startsWith(".env."),
    );
  }

  private dangerousCommand(call: ToolCall): boolean {
    const command = String(call.args.command ?? "");

    return this.policy.deniedCommandFragments.some((fragment) =>
      command.includes(fragment),
    );
  }

  private commandReferencesDeniedPath(call: ToolCall): boolean {
    const command = String(call.args.command ?? "").replaceAll("\\", "/");

    return /(?:^|[\s"'=])(?:[^\s"';&|<>]*\/)*(?:\.git|node_modules|\.env(?:\.[^/\s"';&|<>]*)?)(?:\/|$|[\s"'])/i.test(
      command,
    );
  }

  private readonlyCommand(call: ToolCall): boolean {
    const command = String(call.args.command ?? "").trim();

    if (!command || hasShellMutationSyntax(command)) {
      return false;
    }

    return READONLY_COMMANDS.some((pattern) => pattern.test(command));
  }
}

const READONLY_COMMANDS = [
  /^(?:pwd|cd(?:\s+[^;&|<>]+)?|ls|dir)(?:\s+[^;&|<>]+)*$/i,
  /^(?:rg|grep|cat|type|head|tail|wc|diff)(?:\s+[^;&|<>]+)*$/i,
  /^git\s+(?:status|diff|log|show|rev-parse|ls-files|grep)(?:\s+[^;&|<>]+)*$/i,
  /^(?:node|npm|npx|pnpm|yarn|bun|deno)\s+(?:--version|-v)$/i,
];

function hasShellMutationSyntax(command: string): boolean {
  return (
    /(?:^|[^<])>{1,2}|[;&|]/.test(command) ||
    /(?:^|\s)--output(?:=|\s)/i.test(command)
  );
}

function normalizePolicyPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}
