import type { CommandExecutor } from "../runtime/commandExecutor.js";
import type { Workspace } from "../runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "./base.js";

export class GlobTool implements Tool {
  name = "Glob";
  description = "Find workspace files by glob pattern.";

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
  ) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const pattern =
      typeof args.pattern === "string" && args.pattern ? args.pattern : "**/*";
    const searchPath = typeof args.path === "string" ? args.path : ".";
    const limit = normalizeLimit(args.limit, this.defaultLimit);
    const absPath = await this.workspace.resolveExistingDirectory(searchPath);
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
      .map((file) => this.workspace.relative(file))
      .slice(0, limit);
    const totalLines = result.stdout.split(/\r?\n/).filter(Boolean).length;

    return {
      ok: true,
      content: files.join("\n") || "[No files]",
      data: {
        count: files.length,
        pattern,
        truncated: totalLines > limit,
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
