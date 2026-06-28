import type { AgentMessage, AgentResponse } from "../agent/types.js";

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

export interface ModelClient {
  /** Provider capabilities declaration (optional for backwards compatibility). */
  capabilities?: ModelCapabilities;

  complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
    onTextDelta?: (delta: string) => void;
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
