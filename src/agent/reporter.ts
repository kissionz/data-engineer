import type { ToolCall } from "./types.js";

export type ToolStatus =
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "denied";

export interface AgentReporter {
  onTextDelta(delta: string): void;
  onTextEnd(): void;
  onToolStatus(call: ToolCall, status: ToolStatus): void;
}

export const silentReporter: AgentReporter = {
  onTextDelta() {},
  onTextEnd() {},
  onToolStatus() {},
};
