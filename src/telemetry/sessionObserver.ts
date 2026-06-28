import type { SessionEvent } from "../agent/types.js";
import type {
  CancellationPhase,
  TelemetryOutcome,
  TelemetrySink,
} from "./types.js";

const activeObservers = new Set<SessionTelemetryObserver>();

interface PendingOperation {
  startedAt: number;
  name?: string;
}

export interface SessionTelemetryOptions {
  provider: string;
  model: string;
  trigger?: "user" | "resume" | "subagent";
}

export class SessionTelemetryObserver {
  private taskId?: string;
  private sessionId?: string;
  private taskStartedAt = 0;
  private taskFinished = false;
  private modelCallCount = 0;
  private modelAttempt = 0;
  private toolCallCount = 0;
  private readonly modelRequests: PendingOperation[] = [];
  private readonly tools = new Map<string, PendingOperation>();
  private readonly permissions = new Map<string, PendingOperation>();
  private readonly toolNames = new Map<string, string>();
  private eventCount = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sink: TelemetrySink,
    private readonly options: SessionTelemetryOptions,
  ) {
    activeObservers.add(this);
  }

  observe(event: SessionEvent): Promise<void> {
    const operation = this.queue.then(() => this.observeNow(event));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async observeNow(event: SessionEvent): Promise<void> {
    try {
      this.eventCount += 1;
      this.sessionId = event.sessionId;
      if (event.type === "user_message") {
        await this.finishTask("failed", event.timestamp, "superseded");
        this.startTask(
          `${event.sessionId}:${event.sequence}`,
          event.timestamp,
          "user",
        );
        return;
      }

      if (!this.taskId && !startsRecoveryTask(event)) {
        return;
      }
      this.ensureTask(event);
      const taskId = this.taskId;
      if (!taskId) {
        return;
      }

      if (event.type === "assistant_tool_calls") {
        for (const call of event.toolCalls) {
          this.toolNames.set(call.id, call.name);
        }
      } else if (event.type === "model_request_started") {
        const previous = this.modelRequests.pop();
        if (previous) {
          await this.sink.emit({
            type: "model_request_finished",
            taskId,
            provider: this.options.provider,
            model: this.options.model,
            outcome: "failed",
            durationMs: elapsed(previous.startedAt, event.timestamp),
            errorCode: "model_retry",
          });
        }
        this.modelCallCount += 1;
        this.modelAttempt += 1;
        this.modelRequests.push({ startedAt: timestamp(event.timestamp) });
        await this.sink.emit({
          type: "model_request_started",
          taskId,
          provider: this.options.provider,
          model: this.options.model,
          attempt: this.modelAttempt,
        });
      } else if (event.type === "model_response_received") {
        const pending = this.modelRequests.shift();
        this.modelAttempt = 0;
        await this.sink.emit({
          type: "model_request_finished",
          taskId,
          requestId: event.requestId,
          provider: this.options.provider,
          model: this.options.model,
          outcome: "succeeded",
          durationMs: elapsed(pending?.startedAt, event.timestamp),
          inputTokens: event.usage?.inputTokens,
          outputTokens: event.usage?.outputTokens,
          cacheReadTokens: event.usage?.cacheReadTokens,
          estimatedCostUsd: event.usage?.estimatedCostUsd,
        });
      } else if (event.type === "tool_execution_started") {
        this.toolCallCount += 1;
        this.toolNames.set(event.toolCall.id, event.toolCall.name);
        this.tools.set(event.toolCall.id, {
          startedAt: timestamp(event.timestamp),
          name: event.toolCall.name,
        });
        await this.sink.emit({
          type: "tool_started",
          taskId,
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          effect: event.effect,
        });
      } else if (event.type === "tool_result") {
        const pending = this.tools.get(event.toolCallId);
        if (pending) {
          this.tools.delete(event.toolCallId);
          await this.sink.emit({
            type: "tool_finished",
            taskId,
            toolCallId: event.toolCallId,
            toolName: pending.name ?? event.name,
            outcome: toolOutcome(event),
            durationMs: elapsed(pending.startedAt, event.timestamp),
            errorCode: resultCode(event.data),
          });
        } else {
          this.toolCallCount += 1;
          await this.sink.emit({
            type: "tool_started",
            taskId,
            toolCallId: event.toolCallId,
            toolName: event.name,
            effect: "unknown",
          });
          await this.sink.emit({
            type: "tool_finished",
            taskId,
            toolCallId: event.toolCallId,
            toolName: event.name,
            outcome: toolOutcome(event),
            durationMs: 0,
            errorCode: resultCode(event.data),
          });
        }
      } else if (event.type === "approval_requested") {
        const toolName = this.toolNames.get(event.toolCallId) ?? "unknown";
        this.permissions.set(event.toolCallId, {
          startedAt: timestamp(event.timestamp),
          name: toolName,
        });
        await this.sink.emit({
          type: "permission_requested",
          taskId,
          toolCallId: event.toolCallId,
          toolName,
          fingerprint: event.fingerprint,
          scope: event.scope,
        });
      } else if (event.type === "approval_resolved") {
        const pending = this.permissions.get(event.toolCallId);
        this.permissions.delete(event.toolCallId);
        await this.sink.emit({
          type: "permission_resolved",
          taskId,
          toolCallId: event.toolCallId,
          toolName:
            pending?.name ??
            this.toolNames.get(event.toolCallId) ??
            "unknown",
          decision: event.decision,
          durationMs: elapsed(pending?.startedAt, event.timestamp),
        });
      } else if (event.type === "summary") {
        await this.sink.emit({
          type: "compaction_started",
          taskId,
          trigger: "automatic",
          messageCount: Math.max(0, this.eventCount - 1),
        });
        await this.sink.emit({
          type: "compaction_finished",
          taskId,
          outcome: "succeeded",
          durationMs: 0,
          messagesBefore: Math.max(0, this.eventCount - 1),
          messagesAfter: this.eventCount,
        });
      } else if (event.type === "session_cancelled") {
        const phase = this.currentPhase();
        await this.sink.emit({
          type: "cancellation_requested",
          taskId,
          source: this.options.trigger === "subagent" ? "parent" : "user",
          phase,
          reasonCode: "task_cancelled",
        });
        await this.sink.emit({
          type: "cancellation_finished",
          taskId,
          phase,
          durationMs: 0,
        });
      } else if (event.type === "session_failed") {
        await this.finishPendingModel(event.timestamp, "session_failed");
      } else if (event.type === "session_status_changed") {
        if (event.status === "completed") {
          await this.finishTask("succeeded", event.timestamp);
        } else if (event.status === "cancelled") {
          await this.finishTask("cancelled", event.timestamp);
        } else if (event.status === "failed") {
          await this.finishTask("failed", event.timestamp, "session_failed");
        }
      }
    } catch {
      // Telemetry must never alter session persistence or task execution.
    }
  }

  private ensureTask(event: SessionEvent): void {
    if (this.taskId) {
      return;
    }
    this.startTask(
      `${event.sessionId}:recovery:${event.sequence}`,
      event.timestamp,
      this.options.trigger ?? "resume",
    );
  }

  private startTask(
    taskId: string,
    eventTimestamp: string,
    trigger: "user" | "resume" | "subagent",
  ): void {
    this.taskId = taskId;
    this.taskStartedAt = timestamp(eventTimestamp);
    this.taskFinished = false;
    this.modelCallCount = 0;
    this.modelAttempt = 0;
    this.toolCallCount = 0;
    this.modelRequests.length = 0;
    this.tools.clear();
    this.permissions.clear();
    void this.sink.emit({
      type: "task_started",
      taskId,
      sessionId: this.sessionId,
      trigger: this.options.trigger === "subagent" ? "subagent" : trigger,
    });
  }

  private async finishPendingModel(
    eventTimestamp: string,
    errorCode: string,
  ): Promise<void> {
    const pending = this.modelRequests.shift();
    this.modelAttempt = 0;
    if (!pending || !this.taskId) {
      return;
    }
    await this.sink.emit({
      type: "model_request_finished",
      taskId: this.taskId,
      provider: this.options.provider,
      model: this.options.model,
      outcome: "failed",
      durationMs: elapsed(pending.startedAt, eventTimestamp),
      errorCode,
    });
  }

  private async finishTask(
    outcome: TelemetryOutcome,
    eventTimestamp: string,
    errorCode?: string,
  ): Promise<void> {
    if (!this.taskId || this.taskFinished) {
      return;
    }
    this.taskFinished = true;
    await this.finishPendingModel(eventTimestamp, errorCode ?? "interrupted");
    await this.sink.emit({
      type: "task_finished",
      taskId: this.taskId,
      sessionId: this.sessionId,
      outcome,
      durationMs: elapsed(this.taskStartedAt, eventTimestamp),
      modelCallCount: this.modelCallCount,
      toolCallCount: this.toolCallCount,
      errorCode,
    });
  }

  private currentPhase(): CancellationPhase {
    if (this.permissions.size > 0) {
      return "permission";
    }
    if (this.tools.size > 0) {
      return "tool";
    }
    if (this.modelRequests.length > 0) {
      return "model";
    }
    return "unknown";
  }
}

function startsRecoveryTask(event: SessionEvent): boolean {
  return [
    "assistant_tool_calls",
    "model_request_started",
    "model_response_received",
    "approval_requested",
    "approval_resolved",
    "tool_execution_started",
    "tool_result",
    "session_cancelled",
    "session_failed",
  ].includes(event.type);
}

export async function flushSessionTelemetryObservers(): Promise<void> {
  await Promise.allSettled(
    [...activeObservers].map((observer) => observer.flush()),
  );
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function elapsed(startedAt: number | undefined, finishedAt: string): number {
  return Math.max(0, timestamp(finishedAt) - (startedAt ?? timestamp(finishedAt)));
}

function toolOutcome(
  event: Extract<SessionEvent, { type: "tool_result" }>,
): TelemetryOutcome {
  if (event.ok) {
    return "succeeded";
  }
  return resultCode(event.data) === "user_rejected" ? "rejected" : "failed";
}

function resultCode(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  for (const key of ["code", "reason"]) {
    if (typeof data[key] === "string") {
      return data[key];
    }
  }
  return undefined;
}
