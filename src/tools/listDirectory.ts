import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../runtime/workspace.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";
import { fileOperationFailure } from "./fileErrors.js";

interface DirectoryEntryResult {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
}

export class ListDirectoryTool implements Tool {
  name = "ListDirectory";
  description =
    "List immediate files and subdirectories. Absolute paths outside the workspace may be requested and will use the folder approval flow.";
  effect = "readonly" as const;

  inputSchema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "number" },
    },
    additionalProperties: false,
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly defaultLimit = 300,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const requestedPath =
      typeof args.path === "string" && args.path ? args.path : ".";
    const limit = normalizeLimit(args.limit, this.defaultLimit);

    try {
      const absolutePath = await this.workspace.resolveExistingDirectory(
        requestedPath,
        {
          allowOutside: context?.userApproved === true,
          outsideRoot: context?.approvedFolder,
        },
      );
      const entries = (await readdir(absolutePath, { withFileTypes: true }))
        .filter((entry) => !isSensitiveEntry(absolutePath, entry.name))
        .map((entry): DirectoryEntryResult => {
          const entryPath = path.join(absolutePath, entry.name);
          return {
            name: entry.name,
            path: this.workspace.contains(entryPath)
              ? this.workspace.relative(entryPath)
              : entryPath,
            type: entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : entry.isSymbolicLink()
                  ? "symlink"
                  : "other",
          };
        })
        .sort(
          (left, right) =>
            typeOrder(left.type) - typeOrder(right.type) ||
            left.name.localeCompare(right.name),
        );
      const selected = entries.slice(0, limit);

      return {
        ok: true,
        content:
          selected.length === 0
            ? "[Empty directory]"
            : selected
                .map(
                  (entry) =>
                    `${entry.type === "directory" ? "[D]" : entry.type === "file" ? "[F]" : entry.type === "symlink" ? "[L]" : "[?]"} ${entry.path}`,
                )
                .join("\n"),
        data: {
          path: this.workspace.contains(absolutePath)
            ? this.workspace.relative(absolutePath) || "."
            : absolutePath,
          entries: selected,
          count: selected.length,
          truncated: entries.length > limit,
        },
      };
    } catch (error: unknown) {
      return fileOperationFailure(error);
    }
  }
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), 2_000);
}

function typeOrder(type: DirectoryEntryResult["type"]): number {
  return type === "directory"
    ? 0
    : type === "file"
      ? 1
      : type === "symlink"
        ? 2
        : 3;
}

function isSensitiveEntry(parent: string, name: string): boolean {
  const normalized = name.toLowerCase();
  if (
    normalized === ".git" ||
    normalized === "node_modules" ||
    normalized === ".env" ||
    normalized.startsWith(".env.")
  ) {
    return true;
  }
  return (
    path.basename(parent).toLowerCase() === ".harness" &&
    normalized === "permissions"
  );
}
