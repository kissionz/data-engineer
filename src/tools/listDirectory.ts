import { readdir } from "node:fs/promises";
import path from "node:path";
import { throwIfCancelled } from "../agent/cancellation.js";
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
  depth: number;
}

export class ListDirectoryTool implements Tool {
  name = "ListDirectory";
  description =
    "List a directory tree, including nested files and subdirectories. Defaults to 3 levels; use max_depth to control recursion. Absolute paths outside the workspace may be requested and will use the folder approval flow.";
  effect = "readonly" as const;

  inputSchema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "number" },
      max_depth: { type: "number" },
    },
    additionalProperties: false,
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly defaultLimit = 300,
    private readonly defaultMaxDepth = 3,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const requestedPath =
      typeof args.path === "string" && args.path ? args.path : ".";
    const limit = normalizeLimit(args.limit, this.defaultLimit);
    const maxDepth = normalizeDepth(args.max_depth, this.defaultMaxDepth);

    try {
      throwIfCancelled(context?.signal);
      const absolutePath = await this.workspace.resolveExistingDirectory(
        requestedPath,
        {
          allowOutside: context?.userApproved === true,
          outsideRoot: context?.approvedFolder,
        },
      );
      const { entries, truncated } = await listTree(
        absolutePath,
        maxDepth,
        limit,
        this.workspace,
        context?.signal,
      );

      return {
        ok: true,
        content:
          entries.length === 0
            ? "[Empty directory]"
            : entries
                .map(
                  (entry) =>
                    `${"  ".repeat(entry.depth - 1)}${entry.type === "directory" ? "[D]" : entry.type === "file" ? "[F]" : entry.type === "symlink" ? "[L]" : "[?]"} ${entry.path}`,
                )
                .join("\n"),
        data: {
          path: this.workspace.contains(absolutePath)
            ? this.workspace.relative(absolutePath) || "."
            : absolutePath,
          entries,
          count: entries.length,
          maxDepth,
          truncated,
        },
      };
    } catch (error: unknown) {
      return fileOperationFailure(error);
    }
  }
}

async function listTree(
  root: string,
  maxDepth: number,
  limit: number,
  workspace: Workspace,
  signal?: AbortSignal,
): Promise<{ entries: DirectoryEntryResult[]; truncated: boolean }> {
  const results: DirectoryEntryResult[] = [];
  let truncated = false;

  const visit = async (directory: string, depth: number): Promise<void> => {
    throwIfCancelled(signal);
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !isSensitiveEntry(directory, entry.name))
      .sort(
        (left, right) =>
          typeOrder(directoryEntryType(left)) -
            typeOrder(directoryEntryType(right)) ||
          left.name.localeCompare(right.name),
      );

    for (const entry of entries) {
      throwIfCancelled(signal);
      if (results.length >= limit) {
        truncated = true;
        return;
      }
      const entryPath = path.join(directory, entry.name);
      const type = directoryEntryType(entry);
      results.push({
        name: entry.name,
        path: workspace.contains(entryPath)
          ? workspace.relative(entryPath)
          : entryPath,
        type,
        depth,
      });
      if (type === "directory" && depth < maxDepth) {
        await visit(entryPath, depth + 1);
        if (truncated) {
          return;
        }
      }
    }
  };

  await visit(root, 1);
  return { entries: results, truncated };
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), 2_000);
}

function normalizeDepth(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), 10);
}

function directoryEntryType(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): DirectoryEntryResult["type"] {
  return entry.isDirectory()
    ? "directory"
    : entry.isFile()
      ? "file"
      : entry.isSymbolicLink()
        ? "symlink"
        : "other";
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
