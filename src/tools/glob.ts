import type { CommandExecutor } from "../runtime/commandExecutor.js";
import {
  isCancellationError,
} from "../agent/cancellation.js";
import type { Workspace } from "../runtime/workspace.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";
import { matchesGlob, walkSearchFiles } from "./fileSearch.js";

export class GlobTool implements Tool {
  name = "Glob";
  description =
    "Find files recursively by exact or partial filename pattern. Prefer this over ListDirectory when locating a file; for example pattern **/*config* or **/AGENTS.md with path set to the workspace or an authorized external root. Absolute paths outside the workspace may be requested and will use the folder approval flow.";

  inputSchema = {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "number" },
    },
    additionalProperties: false,
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly executor: CommandExecutor,
    private readonly defaultLimit = 300,
    private readonly useRipgrep = true,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const pattern =
      typeof args.pattern === "string" && args.pattern ? args.pattern : "**/*";
    const searchPath = typeof args.path === "string" ? args.path : ".";
    const limit = normalizeLimit(args.limit, this.defaultLimit);
    const absPath = await this.workspace.resolveExistingDirectory(searchPath, {
      allowOutside: context?.userApproved === true,
      outsideRoot: context?.approvedFolder,
    });
    if (!this.useRipgrep) {
      return this.executeNative(absPath, pattern, limit, context);
    }
    const result = await this.executor.run({
      command: "rg",
      args: [
        "--files",
        "--hidden",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/node_modules/**",
        "--glob",
        "!**/dist/**",
        "--glob",
        "!**/.env",
        "--glob",
        "!**/.env.*",
        "--glob",
        pattern,
        absPath,
      ],
      cwd: this.workspace.root,
      timeoutMs: 20_000,
      signal: context?.signal,
    });

    if (!result.ok && result.exitCode !== 1) {
      return {
        ok: false,
        content: result.stderr || "Unable to list files.",
        data: { exitCode: result.exitCode },
      };
    }

    const files = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) =>
        this.workspace.contains(file) ? this.workspace.relative(file) : file,
      )
      .slice(0, limit);
    const totalLines = result.stdout.split(/\r?\n/).filter(Boolean).length;

    return {
      ok: true,
      content: files.join("\n") || "[No files]",
      data: {
        count: files.length,
        pattern,
        truncated: totalLines > limit,
        engine: "ripgrep",
      },
    };
  }

  private async executeNative(
    searchRoot: string,
    pattern: string,
    limit: number,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const files: string[] = [];
    let truncated = false;

    try {
      for await (const file of walkSearchFiles(searchRoot, context?.signal)) {
        if (!matchesGlob(searchRoot, file, pattern)) {
          continue;
        }
        if (files.length >= limit) {
          truncated = true;
          break;
        }
        files.push(
          this.workspace.contains(file) ? this.workspace.relative(file) : file,
        );
      }
    } catch (error: unknown) {
      if (isCancellationError(error, context?.signal)) {
        return {
          ok: false,
          content: "File search cancelled.",
          data: { code: "cancelled", retryable: false },
        };
      }
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ok: true,
      content: files.join("\n") || "[No files]",
      data: {
        count: files.length,
        pattern,
        truncated,
        engine: "native",
      },
    };
  }
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(value), 1), 2_000);
}
