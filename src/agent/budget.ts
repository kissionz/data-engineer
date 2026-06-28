export interface AgentBudget {
  maxTurns: number;
  maxWallTimeMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxModelRetries: number;
  maxEstimatedCostUsd?: number;
}

export interface BudgetUsage {
  turns: number;
  wallTimeMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  modelRetries: number;
  estimatedCostUsd: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}

export type BudgetExhaustionCode =
  | "turn_budget_reached"
  | "wall_time_budget_reached"
  | "input_token_budget_reached"
  | "output_token_budget_reached"
  | "tool_call_budget_reached"
  | "model_retry_budget_reached"
  | "estimated_cost_budget_reached";

export interface BudgetExhaustion {
  code: BudgetExhaustionCode;
  message: string;
  limit: number;
  used: number;
}

export type BudgetCheck =
  | {
      ok: true;
      usage: BudgetUsage;
    }
  | {
      ok: false;
      usage: BudgetUsage;
      exhaustion: BudgetExhaustion;
    };

export interface ProviderUsageRecord {
  recorded: boolean;
  usage: BudgetUsage;
  exhaustion?: BudgetExhaustion;
}

export interface BudgetTrackerOptions {
  clock?: () => number;
}

export const DEFAULT_AGENT_BUDGET: Readonly<AgentBudget> = Object.freeze({
  maxTurns: 50,
  maxWallTimeMs: 30 * 60 * 1_000,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 250_000,
  maxToolCalls: 200,
  maxModelRetries: 10,
});

const EXHAUSTION_MESSAGES: Record<BudgetExhaustionCode, string> = {
  turn_budget_reached: "Stopped: turn budget reached.",
  wall_time_budget_reached: "Stopped: wall-time budget reached.",
  input_token_budget_reached: "Stopped: token budget reached.",
  output_token_budget_reached: "Stopped: token budget reached.",
  tool_call_budget_reached: "Stopped: tool-call budget reached.",
  model_retry_budget_reached: "Stopped: model-retry budget reached.",
  estimated_cost_budget_reached: "Stopped: estimated-cost budget reached.",
};

interface MutableUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  modelRetries: number;
  estimatedCostUsd: number;
}

interface UsageDelta {
  turns?: number;
  toolCalls?: number;
  modelRetries?: number;
}

export class AgentBudgetTracker {
  readonly limits: Readonly<AgentBudget>;

  private readonly clock: () => number;
  private readonly startedAt: number;
  private lastClockValue: number;
  private readonly usageState: MutableUsage = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    modelRetries: 0,
    estimatedCostUsd: 0,
  };
  private readonly providerUsageRecords = new Map<string, ProviderUsage>();

  constructor(
    budget: Partial<AgentBudget> = {},
    options: BudgetTrackerOptions = {},
  ) {
    this.limits = Object.freeze(validateBudget({
      ...DEFAULT_AGENT_BUDGET,
      ...budget,
    }));
    this.clock = options.clock ?? (() => performance.now());
    this.startedAt = readClock(this.clock);
    this.lastClockValue = this.startedAt;
  }

  get usage(): BudgetUsage {
    return this.snapshot();
  }

  check(): BudgetCheck {
    return this.checkDelta({});
  }

  checkBeforeModelTurn(): BudgetCheck {
    return this.checkDelta({ turns: 1 });
  }

  checkBeforeToolCall(): BudgetCheck {
    return this.checkDelta({ toolCalls: 1 });
  }

  checkBeforeModelRetry(): BudgetCheck {
    return this.checkDelta({ modelRetries: 1 });
  }

  beginModelTurn(): BudgetCheck {
    return this.consume({ turns: 1 });
  }

  beginToolCall(): BudgetCheck {
    return this.consume({ toolCalls: 1 });
  }

  beginModelRetry(): BudgetCheck {
    return this.consume({ modelRetries: 1 });
  }

  recordProviderUsage(
    accountingId: string,
    providerUsage: ProviderUsage,
  ): ProviderUsageRecord {
    const id = validateAccountingId(accountingId);
    const normalized = validateProviderUsage(providerUsage);
    const existing = this.providerUsageRecords.get(id);

    if (existing) {
      if (!sameProviderUsage(existing, normalized)) {
        throw new Error(
          `Provider usage accounting ID "${id}" was reused with different values.`,
        );
      }

      const check = this.check();
      return {
        recorded: false,
        usage: check.usage,
        ...(!check.ok && { exhaustion: check.exhaustion }),
      };
    }

    const nextInputTokens = safeAdd(
      this.usageState.inputTokens,
      normalized.inputTokens,
      "inputTokens",
    );
    const nextOutputTokens = safeAdd(
      this.usageState.outputTokens,
      normalized.outputTokens,
      "outputTokens",
    );
    const nextEstimatedCostUsd = addCost(
      this.usageState.estimatedCostUsd,
      normalized.estimatedCostUsd ?? 0,
    );

    this.providerUsageRecords.set(id, normalized);
    this.usageState.inputTokens = nextInputTokens;
    this.usageState.outputTokens = nextOutputTokens;
    this.usageState.estimatedCostUsd = nextEstimatedCostUsd;

    const check = this.check();
    return {
      recorded: true,
      usage: check.usage,
      ...(!check.ok && { exhaustion: check.exhaustion }),
    };
  }

  private consume(delta: UsageDelta): BudgetCheck {
    const check = this.checkDelta(delta);

    if (!check.ok) {
      return check;
    }

    this.usageState.turns += delta.turns ?? 0;
    this.usageState.toolCalls += delta.toolCalls ?? 0;
    this.usageState.modelRetries += delta.modelRetries ?? 0;
    return { ok: true, usage: this.snapshot() };
  }

  private checkDelta(delta: UsageDelta): BudgetCheck {
    const usage = this.snapshot();
    const exhaustion = findExhaustion(this.limits, usage, delta);

    return exhaustion
      ? { ok: false, usage, exhaustion }
      : { ok: true, usage };
  }

  private snapshot(): BudgetUsage {
    const now = readClock(this.clock);

    if (now < this.lastClockValue) {
      throw new Error("Budget clock must be monotonic.");
    }

    this.lastClockValue = now;
    return {
      ...this.usageState,
      wallTimeMs: now - this.startedAt,
    };
  }
}

function findExhaustion(
  budget: Readonly<AgentBudget>,
  usage: BudgetUsage,
  delta: UsageDelta,
): BudgetExhaustion | undefined {
  if (usage.wallTimeMs >= budget.maxWallTimeMs) {
    return exhaustion(
      "wall_time_budget_reached",
      budget.maxWallTimeMs,
      usage.wallTimeMs,
    );
  }

  if (usage.inputTokens >= budget.maxInputTokens) {
    return exhaustion(
      "input_token_budget_reached",
      budget.maxInputTokens,
      usage.inputTokens,
    );
  }

  if (usage.outputTokens >= budget.maxOutputTokens) {
    return exhaustion(
      "output_token_budget_reached",
      budget.maxOutputTokens,
      usage.outputTokens,
    );
  }

  if (
    budget.maxEstimatedCostUsd !== undefined &&
    usage.estimatedCostUsd >= budget.maxEstimatedCostUsd
  ) {
    return exhaustion(
      "estimated_cost_budget_reached",
      budget.maxEstimatedCostUsd,
      usage.estimatedCostUsd,
    );
  }

  const nextTurns = usage.turns + (delta.turns ?? 0);
  if (nextTurns > budget.maxTurns) {
    return exhaustion("turn_budget_reached", budget.maxTurns, usage.turns);
  }

  const nextToolCalls = usage.toolCalls + (delta.toolCalls ?? 0);
  if (nextToolCalls > budget.maxToolCalls) {
    return exhaustion(
      "tool_call_budget_reached",
      budget.maxToolCalls,
      usage.toolCalls,
    );
  }

  const nextRetries = usage.modelRetries + (delta.modelRetries ?? 0);
  if (nextRetries > budget.maxModelRetries) {
    return exhaustion(
      "model_retry_budget_reached",
      budget.maxModelRetries,
      usage.modelRetries,
    );
  }

  return undefined;
}

function exhaustion(
  code: BudgetExhaustionCode,
  limit: number,
  used: number,
): BudgetExhaustion {
  return {
    code,
    message: EXHAUSTION_MESSAGES[code],
    limit,
    used,
  };
}

function validateBudget(budget: AgentBudget): AgentBudget {
  validatePositiveInteger("maxTurns", budget.maxTurns);
  validatePositiveInteger("maxWallTimeMs", budget.maxWallTimeMs);
  validatePositiveInteger("maxInputTokens", budget.maxInputTokens);
  validatePositiveInteger("maxOutputTokens", budget.maxOutputTokens);
  validateNonNegativeInteger("maxToolCalls", budget.maxToolCalls);
  validateNonNegativeInteger("maxModelRetries", budget.maxModelRetries);

  if (budget.maxEstimatedCostUsd !== undefined) {
    validatePositiveFinite(
      "maxEstimatedCostUsd",
      budget.maxEstimatedCostUsd,
    );
  }

  return { ...budget };
}

function validateProviderUsage(usage: ProviderUsage): ProviderUsage {
  if (!usage || typeof usage !== "object") {
    throw new Error("Provider usage must be an object.");
  }

  validateNonNegativeInteger("inputTokens", usage.inputTokens);
  validateNonNegativeInteger("outputTokens", usage.outputTokens);

  if (usage.estimatedCostUsd !== undefined) {
    validateNonNegativeFinite(
      "estimatedCostUsd",
      usage.estimatedCostUsd,
    );
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.estimatedCostUsd !== undefined && {
      estimatedCostUsd: usage.estimatedCostUsd,
    }),
  };
}

function validateAccountingId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Provider usage accounting ID must be a non-empty string.");
  }

  return value;
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function validatePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
}

function validateNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
}

function readClock(clock: () => number): number {
  const value = clock();

  if (!Number.isFinite(value)) {
    throw new Error("Budget clock must return a finite number.");
  }

  return value;
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right;

  if (!Number.isSafeInteger(result)) {
    throw new Error(`${name} total exceeds the safe integer range.`);
  }

  return result;
}

function addCost(left: number, right: number): number {
  const result = left + right;

  if (!Number.isFinite(result)) {
    throw new Error("estimatedCostUsd total must remain finite.");
  }

  return result;
}

function sameProviderUsage(
  left: ProviderUsage,
  right: ProviderUsage,
): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    (left.estimatedCostUsd ?? 0) === (right.estimatedCostUsd ?? 0)
  );
}
