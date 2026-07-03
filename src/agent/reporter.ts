import type { ToolCall } from "./types.js";
import type { ToolExecutionResult } from "../tools/base.js";

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
  onToolStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolExecutionResult,
  ): void;
}

export const silentReporter: AgentReporter = {
  onTextDelta() {},
  onTextEnd() {},
  onToolStatus() {},
};
