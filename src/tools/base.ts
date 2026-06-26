export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  data?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;

  execute(args: Record<string, unknown>): Promise<ToolExecutionResult>;
}
