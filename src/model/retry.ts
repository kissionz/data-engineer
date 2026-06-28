import { setTimeout as delay } from "node:timers/promises";
import { throwIfCancelled } from "../agent/cancellation.js";
import type { AgentMessage, AgentResponse } from "../agent/types.js";
import { isRetryableModelError, ModelRequestError, type ModelClient } from "./base.js";

export interface RetryPolicy {
  /** Maximum number of retries before giving up. Default: 5. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff. Default: 250. */
  baseDelayMs: number;
  /** Maximum delay cap in ms. Default: 5000. */
  maxDelayMs: number;
  /** Optional callback invoked before each retry. Return false to abort. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => boolean | void;
}

const DEFAULT_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

/**
 * Compute the delay (in ms) before the next retry attempt.
 * Respects the Retry-After header if the error provides one.
 */
export function computeRetryDelay(
  error: unknown,
  attempt: number,
  policy: RetryPolicy = DEFAULT_POLICY,
): number {
  if (
    error instanceof ModelRequestError &&
    error.retryAfterMs !== undefined
  ) {
    return error.retryAfterMs;
  }

  const base = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  // Add jitter: ±25%
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * Execute a model completion with automatic retries on transient failures.
 * Returns the final AgentResponse or throws if all retries are exhausted.
 */
export async function completeWithRetry(
  client: ModelClient,
  options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
    onTextDelta?: (delta: string) => void;
    signal?: AbortSignal;
  },
  policy: Partial<RetryPolicy> = {},
): Promise<AgentResponse> {
  const resolved: RetryPolicy = { ...DEFAULT_POLICY, ...policy };
  let lastError: unknown;

  for (let attempt = 0; attempt <= resolved.maxRetries; attempt += 1) {
    throwIfCancelled(options.signal);

    try {
      return await client.complete(options);
    } catch (error: unknown) {
      lastError = error;

      if (!isRetryableModelError(error)) {
        throw error;
      }

      if (attempt >= resolved.maxRetries) {
        throw error;
      }

      const delayMs = computeRetryDelay(error, attempt + 1, resolved);

      if (resolved.onRetry) {
        const shouldContinue = resolved.onRetry(attempt + 1, error, delayMs);
        if (shouldContinue === false) {
          throw error;
        }
      }

      await delay(delayMs, undefined, { signal: options.signal });
    }
  }

  throw lastError;
}
