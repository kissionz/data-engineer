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

    if (call.name === "Bash" && this.dangerousCommand(call)) {
      return {
        decision: "deny",
        reason: "Dangerous shell command denied by policy.",
      };
    }

    if (this.policy.allowedTools.has(call.name)) {
      return { decision: "allow", reason: "Tool explicitly allowed." };
    }

    if (this.policy.allowReadonly && ["Read"].includes(call.name)) {
      return { decision: "allow", reason: "Readonly tool." };
    }

    if (["Edit", "Write"].includes(call.name) && this.policy.askForWrite) {
      return { decision: "ask", reason: "File modification requires approval." };
    }

    if (call.name === "Bash" && this.policy.askForBash) {
      return { decision: "ask", reason: "Bash command requires approval." };
    }

    return { decision: "ask", reason: "Default ask." };
  }

  private pathDenied(call: ToolCall): boolean {
    const maybePath = call.args.file_path ?? call.args.path ?? call.args.cwd ?? "";
    const normalized = normalizePolicyPath(String(maybePath));

    return this.policy.deniedPathPrefixes.some((prefix) => {
      const normalizedPrefix = normalizePolicyPath(prefix);
      return (
        normalized === normalizedPrefix ||
        normalized.startsWith(`${normalizedPrefix}/`)
      );
    });
  }

  private dangerousCommand(call: ToolCall): boolean {
    const command = String(call.args.command ?? "");

    return this.policy.deniedCommandFragments.some((fragment) =>
      command.includes(fragment),
    );
  }
}

function normalizePolicyPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}
