export type HookEventName = "BeforeToolUse" | "AfterToolUse";
export type HookDecision = "allow" | "block";

export interface HookResult {
  decision: HookDecision;
  reason?: string;
  data?: Record<string, unknown>;
}

export type HookHandler = (
  payload: Record<string, unknown>,
) => Promise<HookResult | null> | HookResult | null;
