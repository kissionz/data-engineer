import type {
  BackgroundCommandManager,
  BackgroundCommandSnapshot,
} from "../runtime/backgroundCommands.js";
import type {
  Tool,
  ToolExecutionResult,
} from "./base.js";

export class BashTaskTool implements Tool {
  name = "BashTask";
  description =
    "Inspect, briefly wait for, or stop a background Bash task from this session.";
  effect = "readonly" as const;

  inputSchema = {
    type: "object",
    properties: {
      task_id: { type: "string" },
      wait_seconds: { type: "number" },
      stop: { type: "boolean" },
    },
    required: ["task_id"],
    additionalProperties: false,
  };

  constructor(private readonly tasks: BackgroundCommandManager) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (typeof args.task_id !== "string" || !args.task_id.trim()) {
      return { ok: false, content: "task_id must be a non-empty string." };
    }
    if (args.stop !== undefined && typeof args.stop !== "boolean") {
      return { ok: false, content: "stop must be a boolean." };
    }
    if (
      args.wait_seconds !== undefined &&
      (typeof args.wait_seconds !== "number" ||
        !Number.isFinite(args.wait_seconds))
    ) {
      return { ok: false, content: "wait_seconds must be a finite number." };
    }

    try {
      const snapshot = args.stop === true
        ? await this.tasks.stop(args.task_id)
        : await this.tasks.get(
            args.task_id,
            Math.min(Math.max(Number(args.wait_seconds ?? 0), 0), 30) * 1_000,
          );
      return snapshotResult(snapshot);
    } catch (error: unknown) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        data: { code: "unknown_background_task", retryable: false },
      };
    }
  }
}

function snapshotResult(
  snapshot: BackgroundCommandSnapshot,
): ToolExecutionResult {
  const output = [
    `Task ${snapshot.taskId}: ${snapshot.status}`,
    snapshot.stdout ? `[stdout]\n${snapshot.stdout}` : "",
    snapshot.stderr ? `[stderr]\n${snapshot.stderr}` : "",
  ].filter(Boolean).join("\n\n");
  const terminal = snapshot.status !== "running";

  return {
    ok: !["failed", "timed_out"].includes(snapshot.status),
    content: output,
    data: {
      taskId: snapshot.taskId,
      status: snapshot.status,
      terminal,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
      exitCode: snapshot.exitCode,
      truncated: snapshot.outputTruncated,
      cleanupFailed: snapshot.cleanupFailed,
    },
  };
}
