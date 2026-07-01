import path from "node:path";
import type { ToolCall } from "../agent/types.js";
import { isPathWithin } from "../runtime/pathSafety.js";
import {
  type FolderGrantManager,
  type FolderGrantRequest,
  type FolderGrantScope,
} from "./folderGrants.js";
import type { PermissionPolicy } from "./policy.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
  folderGrant?: FolderGrantRequest;
  authorizedByFolderGrant?: boolean;
}

export class PermissionGate {
  constructor(
    private readonly policy: PermissionPolicy,
    private readonly workspaceRoot?: string,
    private readonly folderGrants?: FolderGrantManager,
  ) {}

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

    const folderGrant = this.outsideFolderGrant(call);
    if (folderGrant && this.folderGrants?.allows(folderGrant)) {
      return {
        decision: "allow",
        reason: `Folder access was previously granted: ${folderGrant.folder}`,
        folderGrant,
        authorizedByFolderGrant: true,
      };
    }

    const outsidePath = this.outsideWorkspacePath(call);
    if (outsidePath) {
      return {
        decision: "ask",
        reason: `Access outside the workspace requires approval: ${outsidePath}`,
        ...(folderGrant ? { folderGrant } : {}),
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

    if (call.name === "Bash" && this.policy.askForBash) {
      return { decision: "ask", reason: "Bash command requires approval." };
    }

    return { decision: "ask", reason: "Default ask." };
  }

  private pathDenied(call: ToolCall): boolean {
    const paths = [
      call.args.file_path,
      call.args.path,
      call.args.cwd,
    ].filter((value): value is string => typeof value === "string");

    return paths.some((candidate) => {
      const normalized = normalizePolicyPath(candidate);
      const segments = normalized
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLowerCase());

      return this.policy.deniedPathPrefixes.some((prefix) =>
        containsDeniedPath(segments, prefix),
      );
    });
  }

  private dangerousCommand(call: ToolCall): boolean {
    const command = String(call.args.command ?? "");

    return this.policy.deniedCommandFragments.some((fragment) =>
      command.includes(fragment),
    );
  }

  private commandReferencesDeniedPath(call: ToolCall): boolean {
    const command = String(call.args.command ?? "").replaceAll("\\", "/");

    return this.policy.deniedPathPrefixes.some((rawPrefix) => {
      const normalized = normalizePolicyPath(rawPrefix)
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
      if (!normalized) {
        return false;
      }
      const pathPattern =
        normalized === ".env"
          ? String.raw`\.env(?:\.[^/\s"';&|<>]*)?`
          : escapeRegExp(normalized);
      return new RegExp(
        String.raw`(?:^|[\s"'=])(?:[^\s"';&|<>]*\/)*${pathPattern}(?:\/|$|[\s"'])`,
        "i",
      ).test(command);
    });
  }

  private outsideWorkspacePath(call: ToolCall): string | undefined {
    if (!this.workspaceRoot) {
      return undefined;
    }

    const candidates = [
      call.args.file_path,
      call.args.path,
      call.args.cwd,
    ].filter((value): value is string => typeof value === "string");

    return candidates
      .map((candidate) => path.resolve(this.workspaceRoot!, candidate))
      .find((candidate) => !isPathWithin(this.workspaceRoot!, candidate));
  }

  private outsideFolderGrant(
    call: ToolCall,
  ): FolderGrantRequest | undefined {
    if (!this.workspaceRoot) {
      return undefined;
    }

    let candidate: string | undefined;
    let access: FolderGrantRequest["access"] | undefined;
    if (["Read", "Write", "Edit"].includes(call.name)) {
      if (typeof call.args.file_path !== "string") {
        return undefined;
      }
      candidate = path.dirname(
        path.resolve(this.workspaceRoot, call.args.file_path),
      );
      access = call.name === "Read" ? "read" : "read_write";
    } else if (["ListDirectory", "Grep", "Glob"].includes(call.name)) {
      if (typeof call.args.path !== "string") {
        return undefined;
      }
      candidate = path.resolve(this.workspaceRoot, call.args.path);
      access = "read";
    }

    if (
      !candidate ||
      !access ||
      isPathWithin(this.workspaceRoot, candidate)
    ) {
      return undefined;
    }
    return { folder: candidate, access };
  }

  async grantFolder(
    request: FolderGrantRequest,
    scope: FolderGrantScope,
  ): Promise<void> {
    if (!this.folderGrants) {
      throw new Error("Folder permission storage is unavailable.");
    }
    await this.folderGrants.grant(request, scope);
  }
}

function normalizePolicyPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsDeniedPath(segments: string[], rawPrefix: string): boolean {
  const prefix = normalizePolicyPath(rawPrefix)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (prefix.length === 0) {
    return false;
  }

  return segments.some((segment, start) => {
    if (
      prefix.length === 1 &&
      prefix[0] === ".env" &&
      segment.startsWith(".env.")
    ) {
      return true;
    }
    return prefix.every(
      (prefixSegment, offset) => segments[start + offset] === prefixSegment,
    );
  });
}
