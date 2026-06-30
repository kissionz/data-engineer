import type { CommandExecutor } from "../runtime/commandExecutor.js";
import type { Workspace } from "../runtime/workspace.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";

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
    additionalProperties: false,
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly executor: CommandExecutor,
    private readonly maxOutputChars = 12_000,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (typeof args.pattern !== "string" || !args.pattern) {
      return { ok: false, content: "pattern must be a non-empty string." };
    }

    const searchPath = typeof args.path === "string" ? args.path : ".";
    const accessOptions = { allowOutside: context?.userApproved === true };
    const absPath = this.workspace.resolve(searchPath, accessOptions);
    await this.workspace.assertRealPathWithin(absPath, accessOptions);
    const result = await this.executor.run({
      command: "rg",
      args: [
        "--line-number",
        "--hidden",
        "--glob",
        "!**/node_modules/**",
        "--glob",
        "!**/dist/**",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/.env",
        "--glob",
        "!**/.env.*",
        args.pattern,
        absPath,
      ],
      cwd: this.workspace.root,
      timeoutMs: 20_000,
      signal: context?.signal,
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
