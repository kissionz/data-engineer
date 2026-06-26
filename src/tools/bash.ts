import type { CommandExecutor } from "../runtime/commandExecutor.js";
import type { Workspace } from "../runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "./base.js";

export class BashTool implements Tool {
  name = "Bash";
  description = "Run a shell command in the workspace.";

  inputSchema = {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeout_seconds: { type: "number" },
    },
    required: ["command"],
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly executor: CommandExecutor,
    private readonly maxOutputChars = 12_000,
  ) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (typeof args.command !== "string") {
      return { ok: false, content: "command must be a string." };
    }

    const cwdArg = typeof args.cwd === "string" ? args.cwd : ".";
    const cwd = await this.workspace.resolveExistingDirectory(cwdArg);
    const timeoutSeconds =
      typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
        ? args.timeout_seconds
        : 30;
    const timeoutMs = Math.min(Math.max(timeoutSeconds, 1), 120) * 1000;

    const result = await this.executor.run({
      command: args.command,
      cwd,
      timeoutMs,
      shell: true,
    });

    let output = "";

    if (result.stdout) {
      output += `[stdout]\n${result.stdout}\n`;
    }

    if (result.stderr) {
      output += `[stderr]\n${result.stderr}\n`;
    }

    if (!output) {
      output = "[No output]";
    }

    let truncated = false;

    if (output.length > this.maxOutputChars) {
      output = `[Output truncated: showing tail]\n${output.slice(-this.maxOutputChars)}`;
      truncated = true;
    }

    if (result.timedOut) {
      return {
        ok: false,
        content: `Command timed out.\n\n${output}`,
        data: {
          command: args.command,
          exitCode: null,
          timedOut: true,
          truncated,
        },
      };
    }

    return {
      ok: result.ok,
      content: output,
      data: {
        command: args.command,
        exitCode: result.exitCode,
        timedOut: false,
        truncated,
      },
    };
  }
}
