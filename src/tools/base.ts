import type { AgentBudgetTracker } from "../agent/budget.js";
import type { ToolOutcome } from "../protocol.js";

export interface ToolExecutionContext {
  signal?: AbortSignal;
  toolCallId: string;
  userApproved?: boolean;
  approvedFolder?: string;
  taskRunId?: string;
  explicitSubagentRequest?: boolean;
  budget?: AgentBudgetTracker;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Ask capable model providers to enforce the input schema while decoding. */
  strict?: boolean;
  effect?: "readonly" | "side_effect";
  /** Optional per-tool timeout in milliseconds. Overrides the default budget wall time for this tool. */
  timeoutMs?: number;
  source?: {
    type: "builtin" | "mcp";
    serverId?: string;
    remoteName?: string;
  };

  execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolOutcome>;
}
