export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  data?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  toolCallId: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;

  execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
