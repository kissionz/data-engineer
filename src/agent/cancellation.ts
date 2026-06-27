export const CANCELLED_TEXT = "Stopped: task cancelled.";

export class AgentCancelledError extends Error {
  constructor(message = CANCELLED_TEXT) {
    super(message);
    this.name = "AgentCancelledError";
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AgentCancelledError();
  }
}

export function isCancellationError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  return (
    signal?.aborted === true ||
    error instanceof AgentCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export async function raceWithCancellation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfCancelled(signal);

  if (!signal) {
    return operation;
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AgentCancelledError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
