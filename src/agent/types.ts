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

export type SessionEvent =
  | {
      type: "user_message";
      ts: string;
      text: string;
    }
  | {
      type: "assistant_tool_calls";
      ts: string;
      toolCalls: ToolCall[];
    }
  | {
      type: "tool_result";
      ts: string;
      toolCallId: string;
      name: string;
      ok: boolean;
      content: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "assistant_final";
      ts: string;
      text: string;
    }
  | {
      type: "harness_message";
      ts: string;
      kind: "git_diff_review" | "stop_block";
      text: string;
    }
  | {
      type: "session_cancelled";
      ts: string;
      reason: string;
    }
  | {
      type: "session_failed";
      ts: string;
      message: string;
    }
  | {
      type: "summary";
      ts: string;
      text: string;
    };

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
      type: "harness_message";
      kind: "git_diff_review" | "stop_block";
      text: string;
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
