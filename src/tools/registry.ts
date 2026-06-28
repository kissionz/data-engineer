import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";
import { validateSchema, type SchemaValidationResult } from "./schemaValidator.js";

export type ToolValidationResult =
  | SchemaValidationResult
  | { ok: false; errors: string[]; reason: "unknown_tool" };

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

  has(name: string): boolean {
    return this.tools.has(name);
  }

  schemas(): Array<Record<string, unknown>> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  validate(name: string, args: Record<string, unknown>): ToolValidationResult {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        ok: false,
        errors: [`Unknown tool: ${name}.`],
        reason: "unknown_tool",
      };
    }

    return validateSchema(tool.inputSchema, args);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const validation = this.validate(name, args);

    if (!validation.ok) {
      return {
        ok: false,
        content: `Invalid tool call:\n${validation.errors.join("\n")}`,
        data: {
          reason:
            "reason" in validation
              ? validation.reason
              : "invalid_tool_arguments",
          errors: validation.errors,
        },
      };
    }

    const tool = this.get(name);

    // Apply per-tool timeout if defined
    if (tool.timeoutMs && tool.timeoutMs > 0) {
      return this.executeWithTimeout(tool, args, context, tool.timeoutMs);
    }

    return tool.execute(args, context);
  }

  private async executeWithTimeout(
    tool: Tool,
    args: Record<string, unknown>,
    context: ToolExecutionContext | undefined,
    timeoutMs: number,
  ): Promise<ToolExecutionResult> {
    const controller = new AbortController();
    const parentSignal = context?.signal;

    // Link parent signal to child
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await tool.execute(args, {
        ...(context ?? { toolCallId: "" }),
        signal: controller.signal,
      });
      return result;
    } catch (error: unknown) {
      if (
        controller.signal.aborted &&
        !parentSignal?.aborted
      ) {
        // Tool-specific timeout triggered (not parent cancellation)
        return {
          ok: false,
          content: `Tool ${tool.name} timed out after ${timeoutMs}ms.`,
          data: {
            code: "timeout",
            retryable: true,
            timeoutMs,
          },
        };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }
}
