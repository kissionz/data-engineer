export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
  data?: Record<string, unknown>;
}

export interface AgentMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
}

export interface AgentResponse {
  finalText?: string;
  toolCalls?: ToolCall[];
}

export interface SessionEventEnvelope {
  eventId: string;
  sequence: number;
  sessionId: string;
  timestamp: string;
  ts: string;
}

export type SessionStatus =
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "cancelled"
  | "failed";

export type SessionEvent = SessionEventEnvelope &
  (
  | {
      type: "user_message";
      text: string;
    }
  | {
      type: "assistant_tool_calls";
      toolCalls: ToolCall[];
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      ok: boolean;
      content: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "assistant_final";
      text: string;
    }
  | {
      type: "model_request_started";
    }
  | {
      type: "model_response_received";
      hasFinalText: boolean;
      toolCallCount: number;
    }
  | {
      type: "approval_requested";
      toolCallId: string;
      fingerprint: string;
      scope: string;
      reason: string;
    }
  | {
      type: "approval_resolved";
      toolCallId: string;
      fingerprint: string;
      scope: string;
      decision: "reject" | "allow_once" | "allow_session";
    }
  | {
      type: "tool_execution_started";
      toolCall: ToolCall;
      fingerprint: string;
      effect: "readonly" | "side_effect";
    }
  | {
      type: "harness_message";
      kind: "git_diff_review" | "stop_block" | "tool_replay";
      text: string;
    }
  | {
      type: "session_status_changed";
      status: SessionStatus;
    }
  | {
      type: "session_cancelled";
      reason: string;
    }
  | {
      type: "session_failed";
      message: string;
    }
  | {
      type: "summary";
      text: string;
    }
  );

export type SessionEventInput =
  | {
      type: "user_message";
      text: string;
    }
  | {
      type: "assistant_tool_calls";
      toolCalls: ToolCall[];
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      ok: boolean;
      content: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "assistant_final";
      text: string;
    }
  | {
      type: "model_request_started";
    }
  | {
      type: "model_response_received";
      hasFinalText: boolean;
      toolCallCount: number;
    }
  | {
      type: "approval_requested";
      toolCallId: string;
      fingerprint: string;
      scope: string;
      reason: string;
    }
  | {
      type: "approval_resolved";
      toolCallId: string;
      fingerprint: string;
      scope: string;
      decision: "reject" | "allow_once" | "allow_session";
    }
  | {
      type: "tool_execution_started";
      toolCall: ToolCall;
      fingerprint: string;
      effect: "readonly" | "side_effect";
    }
  | {
      type: "harness_message";
      kind: "git_diff_review" | "stop_block" | "tool_replay";
      text: string;
    }
  | {
      type: "session_status_changed";
      status: SessionStatus;
    }
  | {
      type: "session_cancelled";
      reason: string;
    }
  | {
      type: "session_failed";
      message: string;
    }
  | {
      type: "summary";
      text: string;
    };
