import type { CommandExecutor } from "../runtime/commandExecutor.js";
import type { Workspace } from "../runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "./base.js";

export class GrepTool implements Tool {
  name = "Grep";
  description = "Search text in workspace files using ripgrep.";

  inputSchema = {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
    },
    required: ["pattern"],
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly executor: CommandExecutor,
    private readonly maxOutputChars = 12_000,
  ) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (typeof args.pattern !== "string" || !args.pattern) {
      return { ok: false, content: "pattern must be a non-empty string." };
    }

    const searchPath = typeof args.path === "string" ? args.path : ".";
    const absPath = this.workspace.resolve(searchPath);
    const result = await this.executor.run({
      command: `rg --line-number --hidden --glob '!node_modules' --glob '!dist' --glob '!.git' ${shellQuote(args.pattern)} ${shellQuote(absPath)}`,
      cwd: this.workspace.root,
      timeoutMs: 20_000,
    });

    const rawOutput = result.stdout || result.stderr || "[No matches]";
    const truncated = rawOutput.length > this.maxOutputChars;
    const output = truncated
      ? `${rawOutput.slice(0, this.maxOutputChars)}\n[Output truncated]`
      : rawOutput;

    return {
      ok: result.exitCode === 0 || result.exitCode === 1,
      content: output,
      data: {
        exitCode: result.exitCode,
        truncated,
      },
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
