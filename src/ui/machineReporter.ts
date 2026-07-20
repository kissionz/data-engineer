import type { ToolStatus, AgentReporter } from "../agent/reporter.js";
import type { ToolCall, ToolOutcome } from "../protocol.js";
import { summarizeToolCall } from "./toolPresentation.js";

export type OutputFormat = "text" | "json" | "stream-json";
export const MACHINE_OUTPUT_SCHEMA_VERSION = 1 as const;

export interface MachineTextDeltaEvent {
  type: "text_delta";
  schemaVersion: typeof MACHINE_OUTPUT_SCHEMA_VERSION;
  delta: string;
}

export interface MachineTextEndEvent {
  type: "text_end";
  schemaVersion: typeof MACHINE_OUTPUT_SCHEMA_VERSION;
}

export interface MachineToolEvent {
  type: "tool";
  schemaVersion: typeof MACHINE_OUTPUT_SCHEMA_VERSION;
  id: string;
  name: string;
  summary: string;
  status: ToolStatus;
  ok?: boolean;
}

export interface MachineResult {
  type: "result";
  schemaVersion: typeof MACHINE_OUTPUT_SCHEMA_VERSION;
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

export type MachineEvent =
  | MachineTextDeltaEvent
  | MachineTextEndEvent
  | MachineToolEvent
  | MachineResult;

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
      this.emit({
        type: "text_delta",
        schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
        delta,
      });
    }
  }

  onTextEnd(): void {
    if (this.format === "stream-json") {
      this.emit({
        type: "text_end",
        schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
      });
    }
  }

  onToolStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    const event: MachineToolEvent = {
      type: "tool",
      schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
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
      schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
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

  private emit(value: MachineEvent): void {
    this.write(`${JSON.stringify(value)}\n`);
  }
}
