import type { AgentMessage, AgentResponse } from "../agent/types.js";

export interface ModelClient {
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
