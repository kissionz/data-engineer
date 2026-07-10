import { describe, expect, it, vi } from "vitest";
import { ModelRequestError, type ModelClient } from "../src/model/base.js";
import {
  completeWithRetry,
  computeRetryDelay,
} from "../src/model/retry.js";

describe("model retry policy", () => {
  it("honors Retry-After and bounds exponential backoff", () => {
    expect(
      computeRetryDelay(new ModelRequestError("busy", true, 429, 1_250), 1),
    ).toBe(1_250);
    const delay = computeRetryDelay(new TypeError("network"), 10, {
      maxRetries: 10,
      baseDelayMs: 100,
      maxDelayMs: 500,
    });
    expect(delay).toBeGreaterThanOrEqual(375);
    expect(delay).toBeLessThanOrEqual(625);
  });

  it("returns immediately after a successful completion", async () => {
    const complete = vi.fn().mockResolvedValue({
      finalText: "ready",
      stopReason: "end_turn",
    });
    const client: ModelClient = { complete };

    await expect(
      completeWithRetry(client, { messages: [], tools: [] }),
    ).resolves.toMatchObject({ finalText: "ready" });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("retries transient failures and exposes retry telemetry", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new ModelRequestError("busy", true, 503, 0))
      .mockResolvedValue({ finalText: "recovered", stopReason: "end_turn" });
    const onRetry = vi.fn();

    const result = await completeWithRetry(
      { complete },
      { messages: [], tools: [] },
      { maxRetries: 1, onRetry },
    );

    expect(result.finalText).toBe("recovered");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(ModelRequestError), 0);
  });

  it("does not retry permanent errors or a rejected retry callback", async () => {
    const permanent = vi.fn().mockRejectedValue(new Error("invalid request"));
    await expect(
      completeWithRetry(
        { complete: permanent },
        { messages: [], tools: [] },
      ),
    ).rejects.toThrow("invalid request");
    expect(permanent).toHaveBeenCalledOnce();

    const transient = vi
      .fn()
      .mockRejectedValue(new ModelRequestError("busy", true));
    await expect(
      completeWithRetry(
        { complete: transient },
        { messages: [], tools: [] },
        { onRetry: () => false },
      ),
    ).rejects.toThrow("busy");
    expect(transient).toHaveBeenCalledOnce();
  });
});
