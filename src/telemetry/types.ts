export type TaskTrigger =
  | "user"
  | "resume"
  | "subagent"
  | "automation"
  | "unknown";

export type TelemetryOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rejected";

export type ToolEffect = "readonly" | "side_effect" | "unknown";
export type PermissionDecision =
  | "reject"
  | "allow_once"
  | "allow_session"
  | "allow_folder_session"
  | "allow_folder_always";
export type CompactionTrigger = "token_limit" | "manual" | "automatic";
export type CancellationSource = "user" | "timeout" | "system" | "parent";
export type CancellationPhase =
  | "queued"
  | "model"
  | "tool"
  | "permission"
  | "compaction"
  | "unknown";

export type TelemetryEvent =
  | {
      type: "task_started";
      taskId: string;
      sessionId?: string;
      trigger: TaskTrigger;
    }
  | {
      type: "task_finished";
      taskId: string;
      sessionId?: string;
      outcome: TelemetryOutcome;
      durationMs: number;
      modelCallCount?: number;
      toolCallCount?: number;
      errorCode?: string;
    }
  | {
      type: "model_request_started";
      taskId: string;
      requestId?: string;
      provider: string;
      model: string;
      attempt: number;
      maxOutputTokens?: number;
    }
  | {
      type: "model_request_finished";
      taskId: string;
      requestId?: string;
      provider: string;
      model: string;
      outcome: TelemetryOutcome;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      estimatedCostUsd?: number;
      stopReason?: string;
      errorCode?: string;
    }
  | {
      type: "tool_started";
      taskId: string;
      toolCallId: string;
      toolName: string;
      effect: ToolEffect;
    }
  | {
      type: "tool_finished";
      taskId: string;
      toolCallId: string;
      toolName: string;
      outcome: TelemetryOutcome;
      durationMs: number;
      errorCode?: string;
    }
  | {
      type: "permission_requested";
      taskId: string;
      toolCallId: string;
      toolName: string;
      fingerprint?: string;
      scope: string;
    }
  | {
      type: "permission_resolved";
      taskId: string;
      toolCallId: string;
      toolName: string;
      decision: PermissionDecision;
      durationMs: number;
    }
  | {
      type: "compaction_started";
      taskId: string;
      trigger: CompactionTrigger;
      inputTokenCount?: number;
      messageCount: number;
    }
  | {
      type: "compaction_finished";
      taskId: string;
      outcome: TelemetryOutcome;
      durationMs: number;
      inputTokenCount?: number;
      outputTokenCount?: number;
      messagesBefore: number;
      messagesAfter?: number;
      errorCode?: string;
    }
  | {
      type: "cancellation_requested";
      taskId: string;
      source: CancellationSource;
      phase: CancellationPhase;
      reasonCode?: string;
    }
  | {
      type: "cancellation_finished";
      taskId: string;
      phase: CancellationPhase;
      durationMs: number;
    };

export interface TelemetrySink {
  emit(event: TelemetryEvent): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface TelemetrySinkFailure {
  operation: "validate" | "prepare" | "lock" | "read" | "append" | "close";
  error: unknown;
}

export interface JsonlTelemetrySinkOptions {
  maxBytes?: number;
  lockTimeoutMs?: number;
  onError?: (failure: TelemetrySinkFailure) => void;
}
