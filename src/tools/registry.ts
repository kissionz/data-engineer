import type { Tool, ToolExecutionResult } from "./base.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return tool;
  }

  schemas(): Array<Record<string, unknown>> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    return this.get(name).execute(args);
  }
}
