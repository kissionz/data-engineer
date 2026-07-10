import type { ToolStatus, AgentReporter } from "../agent/reporter.js";
import type { ToolCall } from "../agent/types.js";
import type { ToolExecutionResult } from "../tools/base.js";
import { summarizeToolCall } from "./toolPresentation.js";

export type OutputFormat = "text" | "json" | "stream-json";

export interface MachineToolEvent {
  type: "tool";
  id: string;
  name: string;
  summary: string;
  status: ToolStatus;
  ok?: boolean;
}

export interface MachineResult {
  type: "result";
  schemaVersion: 1;
  sessionId: string;
  status: "completed" | "cancelled" | "failed";
  text: string;
  tools: MachineToolEvent[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    estimatedCostUsd: number;
  };
}

export class MachineReporter implements AgentReporter {
  private readonly text: string[] = [];
  private readonly tools: MachineToolEvent[] = [];

  constructor(
    private readonly format: Exclude<OutputFormat, "text">,
    private readonly write: (text: string) => void = (text) =>
      process.stdout.write(text),
  ) {}

  onTextDelta(delta: string): void {
    this.text.push(delta);
    if (this.format === "stream-json") {
      this.emit({ type: "text_delta", delta });
    }
  }

  onTextEnd(): void {
    if (this.format === "stream-json") {
      this.emit({ type: "text_end" });
    }
  }

  onToolStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolExecutionResult,
  ): void {
    const event: MachineToolEvent = {
      type: "tool",
      id: call.id,
      name: call.name,
      summary: summarizeToolCall(call),
      status,
      ...(result ? { ok: result.ok } : {}),
    };
    this.tools.push(event);
    if (this.format === "stream-json") {
      this.emit(event);
    }
  }

  finish(
    sessionId: string,
    status: MachineResult["status"],
    resultText?: string,
    usage?: MachineResult["usage"],
  ): MachineResult {
    const result: MachineResult = {
      type: "result",
      schemaVersion: 1,
      sessionId,
      status,
      text: resultText ?? this.text.join(""),
      tools: [...this.tools],
      ...(usage ? { usage } : {}),
    };
    this.emit(result);
    return result;
  }

  dispose(): void {}

  private emit(value: unknown): void {
    this.write(`${JSON.stringify(value)}\n`);
  }
}
