import type { AgentMessage, AgentResponse, StopReason } from "../agent/types.js";

/**
 * Declares the capabilities of a model provider to inform runtime decisions
 * (e.g., whether streaming is supported, context window size for compaction).
 */
export interface ModelCapabilities {
  /** Maximum total tokens (input + output) the model supports. */
  contextWindow: number;
  /** Maximum output tokens the model supports in a single response. */
  maxOutputTokens: number;
  /** Whether the model supports streaming text deltas. */
  supportsStreaming: boolean;
  /** Whether the model supports tool/function calling. */
  supportsToolUse: boolean;
  /** Whether the model supports image inputs. */
  supportsImages: boolean;
}

/**
 * Provider-agnostic streaming events emitted during model completion.
 * Consumers can observe these without coupling to any specific API format.
 */
export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; toolCallId: string; name: string }
  | { type: "tool_call_args_delta"; toolCallId: string; delta: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "stop"; stopReason: StopReason };

/** Callback to receive streaming events during model completion. */
export type ModelStreamHandler = (event: ModelStreamEvent) => void;

export interface ModelClient {
  /** Provider capabilities declaration (optional for backwards compatibility). */
  capabilities?: ModelCapabilities;

  complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
    onTextDelta?: (delta: string) => void;
    /** Optional richer stream handler for observing all stream events. */
    onStreamEvent?: ModelStreamHandler;
    signal?: AbortSignal;
  }): Promise<AgentResponse>;
}

export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}

export function isRetryableModelError(error: unknown): boolean {
  return (
    (error instanceof ModelRequestError && error.retryable) ||
    error instanceof TypeError
  );
}
