import type { ShellExecutor } from "../runtime/shellExecutor.js";
import type { BackgroundCommandManager } from "../runtime/backgroundCommands.js";
import type { Workspace } from "../runtime/workspace.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";

export class BashTool implements Tool {
  name = "Bash";
  description = "Run a shell command in the workspace.";

  inputSchema = {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeout_seconds: { type: "number" },
      background: { type: "boolean" },
    },
    required: ["command"],
    additionalProperties: false,
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly executor: ShellExecutor,
    private readonly backgroundTasks?: BackgroundCommandManager,
    private readonly maxOutputChars = 12_000,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (typeof args.command !== "string") {
      return { ok: false, content: "command must be a string." };
    }

    const cwdArg = typeof args.cwd === "string" ? args.cwd : ".";
    const cwd = await this.workspace.resolveExistingDirectory(cwdArg, {
      allowOutside: context?.userApproved === true,
    });
    const timeoutSeconds =
      typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
        ? args.timeout_seconds
        : 30;
    const timeoutMs = Math.min(Math.max(timeoutSeconds, 1), 120) * 1000;

    if (args.background === true) {
      if (!this.backgroundTasks) {
        return {
          ok: false,
          content: "Background command execution is unavailable in this runtime.",
        };
      }
      const task = await this.backgroundTasks.start({
        script: args.command,
        cwd,
        timeoutMs,
        maxOutputChars: this.maxOutputChars,
        signal: context?.signal,
      });
      return {
        ok: true,
        content:
          `Background command started. Task ID: ${task.taskId}. ` +
          "Use BashTask to inspect or stop it.",
        data: {
          background: true,
          taskId: task.taskId,
          status: task.status,
          startedAt: task.startedAt,
        },
      };
    }

    const result = await this.executor.runScript({
      script: args.command,
      cwd,
      timeoutMs,
      maxOutputChars: this.maxOutputChars,
      signal: context?.signal,
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

    let truncated = result.outputTruncated ?? false;

    if (output.length > this.maxOutputChars) {
      output = `[Output truncated: showing tail]\n${output.slice(-this.maxOutputChars)}`;
      truncated = true;
    }

    if (result.cancelled) {
      return {
        ok: false,
        content: `Command cancelled.\n\n${output}`,
        data: {
          code: "cancelled",
          retryable: false,
          command: args.command,
          exitCode: result.exitCode,
          timedOut: false,
          cancelled: true,
          cleanupFailed: result.cleanupFailed ?? false,
          truncated,
        },
      };
    }

    if (result.timedOut) {
      return {
        ok: false,
        content: `Command timed out.\n\n${output}`,
        data: {
          command: args.command,
          exitCode: null,
          timedOut: true,
          cancelled: false,
          cleanupFailed: result.cleanupFailed ?? false,
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
        cancelled: false,
        cleanupFailed: result.cleanupFailed ?? false,
        truncated,
      },
    };
  }
}
