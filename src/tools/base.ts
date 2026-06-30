import type { AgentBudgetTracker } from "../agent/budget.js";

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  data?: Record<string, unknown>;
}

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
  ): Promise<ToolExecutionResult>;
}
