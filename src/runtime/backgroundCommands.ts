import { randomUUID } from "node:crypto";
import type { CommandResult } from "./commandExecutor.js";
import type { ShellExecutor, ShellOptions } from "./shellExecutor.js";

const MAX_RUNNING_TASKS = 8;
const MAX_RETAINED_TASKS = 32;

export type BackgroundCommandStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface BackgroundCommandSnapshot {
  taskId: string;
  status: BackgroundCommandStatus;
  startedAt: string;
  completedAt?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  outputTruncated: boolean;
  cleanupFailed: boolean;
}

interface BackgroundCommandState {
  snapshot: BackgroundCommandSnapshot;
  controller: AbortController;
  completion: Promise<BackgroundCommandSnapshot>;
}

export class BackgroundCommandManager {
  private readonly tasks = new Map<string, BackgroundCommandState>();

  constructor(
    private readonly executor: ShellExecutor | undefined,
    private readonly onStatus?: (
      snapshot: BackgroundCommandSnapshot,
    ) => Promise<void> | void,
  ) {}

  async start(options: ShellOptions): Promise<BackgroundCommandSnapshot> {
    if (!this.executor) {
      throw new Error("Bash is unavailable in this runtime.");
    }
    if (this.runningCount() >= MAX_RUNNING_TASKS) {
      throw new Error(
        `At most ${MAX_RUNNING_TASKS} background commands may run at once.`,
      );
    }
    this.pruneCompleted();

    const controller = new AbortController();
    const taskId = randomUUID();
    const snapshot: BackgroundCommandSnapshot = {
      taskId,
      status: "running",
      startedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      exitCode: null,
      outputTruncated: false,
      cleanupFailed: false,
    };
    const state: BackgroundCommandState = {
      snapshot,
      controller,
      completion: Promise.resolve(snapshot),
    };
    this.tasks.set(taskId, state);

    try {
      await this.onStatus?.(cloneSnapshot(snapshot));
    } catch (error: unknown) {
      this.tasks.delete(taskId);
      throw error;
    }

    state.completion = this.execute(state, options);
    return cloneSnapshot(snapshot);
  }

  async get(
    taskId: string,
    waitMs = 0,
  ): Promise<BackgroundCommandSnapshot> {
    const state = this.requireTask(taskId);
    if (state.snapshot.status === "running" && waitMs > 0) {
      await waitForCompletion(state.completion, waitMs);
    }
    return cloneSnapshot(state.snapshot);
  }

  async stop(taskId: string): Promise<BackgroundCommandSnapshot> {
    const state = this.requireTask(taskId);
    if (state.snapshot.status === "running") {
      state.controller.abort(
        new DOMException("Background command stopped.", "AbortError"),
      );
      await state.completion;
    }
    return cloneSnapshot(state.snapshot);
  }

  async dispose(): Promise<void> {
    const running = [...this.tasks.values()].filter(
      (task) => task.snapshot.status === "running",
    );
    for (const task of running) {
      task.controller.abort(
        new DOMException("Session closed.", "AbortError"),
      );
    }
    await Promise.allSettled(running.map((task) => task.completion));
    this.tasks.clear();
  }

  private async execute(
    state: BackgroundCommandState,
    options: ShellOptions,
  ): Promise<BackgroundCommandSnapshot> {
    const parentSignal = options.signal;
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, state.controller.signal])
      : state.controller.signal;
    const callerProgress = options.onProgress;

    try {
      const result = await this.executor!.runScript({
        ...options,
        signal,
        onProgress: (progress) => {
          state.snapshot.stdout = progress.stdout;
          state.snapshot.stderr = progress.stderr;
          state.snapshot.outputTruncated = progress.outputTruncated;
          try {
            callerProgress?.(progress);
          } catch {
            // Progress observers must not alter command execution.
          }
        },
      });
      applyResult(state.snapshot, result);
    } catch (error: unknown) {
      state.snapshot.status = "failed";
      state.snapshot.stderr = safeErrorMessage(error);
    }

    state.snapshot.completedAt = new Date().toISOString();
    try {
      await this.onStatus?.(cloneSnapshot(state.snapshot));
    } catch {
      // A status observer must not replace the command result.
    }
    return cloneSnapshot(state.snapshot);
  }

  private requireTask(taskId: string): BackgroundCommandState {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown background task: ${taskId}`);
    }
    return task;
  }

  private runningCount(): number {
    return [...this.tasks.values()].filter(
      (task) => task.snapshot.status === "running",
    ).length;
  }

  private pruneCompleted(): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.snapshot.status !== "running")
      .sort((left, right) =>
        left.snapshot.startedAt.localeCompare(right.snapshot.startedAt),
      );
    while (
      this.tasks.size >= MAX_RETAINED_TASKS &&
      completed.length > 0
    ) {
      const oldest = completed.shift();
      if (oldest) {
        this.tasks.delete(oldest.snapshot.taskId);
      }
    }
  }
}

function applyResult(
  snapshot: BackgroundCommandSnapshot,
  result: CommandResult,
): void {
  snapshot.stdout = result.stdout;
  snapshot.stderr = result.stderr;
  snapshot.exitCode = result.exitCode;
  snapshot.outputTruncated = result.outputTruncated ?? false;
  snapshot.cleanupFailed = result.cleanupFailed ?? false;
  snapshot.status = result.cancelled
    ? "cancelled"
    : result.timedOut
      ? "timed_out"
      : result.ok
        ? "completed"
        : "failed";
}

async function waitForCompletion(
  completion: Promise<BackgroundCommandSnapshot>,
  waitMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, waitMs));
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function cloneSnapshot(
  snapshot: BackgroundCommandSnapshot,
): BackgroundCommandSnapshot {
  return { ...snapshot };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replaceAll(/\p{Cc}/gu, " ").trim();
  return normalized.length <= 2_000
    ? normalized
    : `${normalized.slice(0, 1_997)}...`;
}
