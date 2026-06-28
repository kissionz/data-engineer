import { describe, expect, it } from "vitest";
import {
  AgentBudgetTracker,
  DEFAULT_AGENT_BUDGET,
  type AgentBudget,
} from "../src/agent/budget.js";

const SMALL_BUDGET: AgentBudget = {
  maxTurns: 2,
  maxWallTimeMs: 1_000,
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxToolCalls: 2,
  maxModelRetries: 1,
  maxEstimatedCostUsd: 0.5,
};

describe("AgentBudgetTracker", () => {
  it("uses production defaults without exposing mutable limits", () => {
    const tracker = new AgentBudgetTracker();

    expect(tracker.limits).toEqual(DEFAULT_AGENT_BUDGET);
    expect(Object.isFrozen(tracker.limits)).toBe(true);
    expect(tracker.usage).toMatchObject({
      turns: 0,
      wallTimeMs: expect.any(Number),
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      modelRetries: 0,
      estimatedCostUsd: 0,
    });
  });

  it("allows the configured number of turns and tools, then rejects before execution", () => {
    const tracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => 0,
    });

    expect(tracker.checkBeforeModelTurn().ok).toBe(true);
    expect(tracker.beginModelTurn()).toMatchObject({
      ok: true,
      usage: { turns: 1 },
    });
    expect(tracker.beginModelTurn()).toMatchObject({
      ok: true,
      usage: { turns: 2 },
    });
    expect(tracker.beginModelTurn()).toMatchObject({
      ok: false,
      exhaustion: {
        code: "turn_budget_reached",
        message: "Stopped: turn budget reached.",
        limit: 2,
        used: 2,
      },
    });
    expect(tracker.usage.turns).toBe(2);

    expect(tracker.beginToolCall().ok).toBe(true);
    expect(tracker.beginToolCall().ok).toBe(true);
    expect(tracker.checkBeforeToolCall()).toMatchObject({
      ok: false,
      exhaustion: {
        code: "tool_call_budget_reached",
        message: "Stopped: tool-call budget reached.",
      },
    });
    expect(tracker.usage.toolCalls).toBe(2);
  });

  it("checks wall time at the exact boundary with an injectable monotonic clock", () => {
    let now = 10_000;
    const tracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => now,
    });

    now += 999;
    expect(tracker.check().ok).toBe(true);

    now += 1;
    expect(tracker.check()).toMatchObject({
      ok: false,
      usage: { wallTimeMs: 1_000 },
      exhaustion: {
        code: "wall_time_budget_reached",
        message: "Stopped: wall-time budget reached.",
        limit: 1_000,
        used: 1_000,
      },
    });
  });

  it("rejects clocks that are invalid or move backwards", () => {
    expect(
      () => new AgentBudgetTracker(SMALL_BUDGET, { clock: () => NaN }),
    ).toThrow("Budget clock must return a finite number.");

    let now = 10;
    const tracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => now,
    });
    now = 9;

    expect(() => tracker.check()).toThrow("Budget clock must be monotonic.");
  });

  it("records provider tokens and optional estimated cost", () => {
    const tracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => 0,
    });

    expect(
      tracker.recordProviderUsage("response-1", {
        inputTokens: 60,
        outputTokens: 20,
        estimatedCostUsd: 0.2,
      }),
    ).toMatchObject({
      recorded: true,
      usage: {
        inputTokens: 60,
        outputTokens: 20,
        estimatedCostUsd: 0.2,
      },
    });

    expect(
      tracker.recordProviderUsage("response-2", {
        inputTokens: 40,
        outputTokens: 0,
      }),
    ).toMatchObject({
      recorded: true,
      exhaustion: {
        code: "input_token_budget_reached",
        message: "Stopped: token budget reached.",
        limit: 100,
        used: 100,
      },
    });
    expect(tracker.checkBeforeModelTurn().ok).toBe(false);
  });

  it("reports output-token and estimated-cost exhaustion", () => {
    const outputTracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => 0,
    });
    const output = outputTracker.recordProviderUsage("output", {
      inputTokens: 0,
      outputTokens: 51,
    });

    expect(output.exhaustion).toMatchObject({
      code: "output_token_budget_reached",
      message: "Stopped: token budget reached.",
      used: 51,
    });

    const costTracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => 0,
    });
    const cost = costTracker.recordProviderUsage("cost", {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0.5,
    });

    expect(cost.exhaustion).toMatchObject({
      code: "estimated_cost_budget_reached",
      message: "Stopped: estimated-cost budget reached.",
      limit: 0.5,
      used: 0.5,
    });
  });

  it("deduplicates identical provider accounting and rejects ID collisions", () => {
    const tracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => 0,
    });
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.05,
    };

    expect(tracker.recordProviderUsage("same-response", usage).recorded).toBe(
      true,
    );
    expect(tracker.recordProviderUsage("same-response", usage)).toMatchObject({
      recorded: false,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 0.05,
      },
    });
    expect(() =>
      tracker.recordProviderUsage("same-response", {
        ...usage,
        outputTokens: 6,
      }),
    ).toThrow('accounting ID "same-response" was reused');
    expect(tracker.usage.outputTokens).toBe(5);
  });

  it("tracks model retry attempts with a pre-execution boundary", () => {
    const tracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => 0,
    });

    expect(tracker.beginModelRetry()).toMatchObject({
      ok: true,
      usage: { modelRetries: 1 },
    });
    expect(tracker.beginModelRetry()).toMatchObject({
      ok: false,
      exhaustion: {
        code: "model_retry_budget_reached",
        message: "Stopped: model-retry budget reached.",
        limit: 1,
        used: 1,
      },
    });
    expect(tracker.usage.modelRetries).toBe(1);
  });

  it("supports disabling tool calls and model retries with zero limits", () => {
    const tracker = new AgentBudgetTracker(
      {
        ...SMALL_BUDGET,
        maxToolCalls: 0,
        maxModelRetries: 0,
      },
      { clock: () => 0 },
    );

    expect(tracker.beginToolCall()).toMatchObject({
      ok: false,
      exhaustion: { code: "tool_call_budget_reached", limit: 0, used: 0 },
    });
    expect(tracker.beginModelRetry()).toMatchObject({
      ok: false,
      exhaustion: { code: "model_retry_budget_reached", limit: 0, used: 0 },
    });
  });

  it.each([
    ["maxTurns", 0],
    ["maxWallTimeMs", -1],
    ["maxInputTokens", 1.5],
    ["maxOutputTokens", Number.NaN],
    ["maxToolCalls", -1],
    ["maxModelRetries", Number.POSITIVE_INFINITY],
    ["maxEstimatedCostUsd", 0],
  ] as const)("rejects invalid budget %s=%s", (field, value) => {
    expect(
      () => new AgentBudgetTracker({ ...SMALL_BUDGET, [field]: value }),
    ).toThrow(field);
  });

  it.each([
    [{ inputTokens: -1, outputTokens: 0 }, "inputTokens"],
    [{ inputTokens: 1.5, outputTokens: 0 }, "inputTokens"],
    [{ inputTokens: 0, outputTokens: Number.NaN }, "outputTokens"],
    [
      {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: Number.POSITIVE_INFINITY,
      },
      "estimatedCostUsd",
    ],
  ])("rejects invalid provider usage %#", (usage, field) => {
    const tracker = new AgentBudgetTracker(SMALL_BUDGET);

    expect(() => tracker.recordProviderUsage("invalid", usage)).toThrow(field);
    expect(tracker.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it("rejects empty accounting IDs and protects safe integer totals", () => {
    const tracker = new AgentBudgetTracker({
      ...SMALL_BUDGET,
      maxInputTokens: Number.MAX_SAFE_INTEGER,
    });

    expect(() =>
      tracker.recordProviderUsage(" ", { inputTokens: 1, outputTokens: 0 }),
    ).toThrow("non-empty string");

    tracker.recordProviderUsage("large", {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
    });
    expect(() =>
      tracker.recordProviderUsage("overflow", {
        inputTokens: 1,
        outputTokens: 0,
      }),
    ).toThrow("safe integer range");
    expect(
      tracker.recordProviderUsage("overflow", {
        inputTokens: 0,
        outputTokens: 1,
      }),
    ).toMatchObject({
      recorded: true,
      usage: { outputTokens: 1 },
    });
  });

  it("returns detached usage snapshots", () => {
    const tracker = new AgentBudgetTracker(SMALL_BUDGET, {
      clock: () => 0,
    });
    const snapshot = tracker.usage;

    snapshot.turns = 99;

    expect(tracker.usage.turns).toBe(0);
  });
});
