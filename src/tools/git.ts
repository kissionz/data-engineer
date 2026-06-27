import type { CommandExecutor } from "../runtime/commandExecutor.js";
import type { Workspace } from "../runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "./base.js";

abstract class GitReadTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract inputSchema: Record<string, unknown>;

  constructor(
    protected readonly workspace: Workspace,
    protected readonly executor: CommandExecutor,
    private readonly maxOutputChars = 20_000,
  ) {}

  protected async run(args: string[]): Promise<ToolExecutionResult> {
    const result = await this.executor.run({
      command: "git",
      args,
      cwd: this.workspace.root,
      timeoutMs: 20_000,
    });
    const rawOutput = result.stdout || result.stderr || "[No changes]";
    const truncated = rawOutput.length > this.maxOutputChars;

    return {
      ok: result.ok,
      content: truncated
        ? `${rawOutput.slice(0, this.maxOutputChars)}\n[Output truncated]`
        : rawOutput,
      data: {
        exitCode: result.exitCode,
        truncated,
      },
    };
  }

  abstract execute(args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

export class GitStatusTool extends GitReadTool {
  name = "GitStatus";
  description = "Show concise workspace git status.";
  inputSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  async execute(): Promise<ToolExecutionResult> {
    return this.run(["status", "--short"]);
  }
}

export class GitDiffTool extends GitReadTool {
  name = "GitDiff";
  description = "Show current git diff, optionally for staged changes.";
  inputSchema = {
    type: "object",
    properties: {
      staged: { type: "boolean" },
    },
    additionalProperties: false,
  };

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const diffArgs = args.staged === true ? ["diff", "--cached"] : ["diff"];

    return this.run([
      ...diffArgs,
      "--",
      ".",
      ":(exclude)**/.env",
      ":(exclude)**/.env.*",
      ":(exclude)**/node_modules/**",
    ]);
  }
}
