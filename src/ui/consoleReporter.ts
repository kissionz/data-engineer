import type { AgentReporter, ToolStatus } from "../agent/reporter.js";
import type { ToolCall } from "../agent/types.js";
import type { ToolExecutionResult } from "../tools/base.js";
import { summarizeToolCall } from "./toolPresentation.js";

const STATUS_LABELS: Record<ToolStatus, string> = {
  awaiting_approval: "waiting approval",
  running: "running",
  succeeded: "done",
  failed: "failed",
  rejected: "rejected",
  denied: "denied",
};

export class ConsoleReporter implements AgentReporter {
  private textOpen = false;
  private activeToolLine = false;

  constructor(
    private readonly writeOutput: (text: string) => void = (text) =>
      process.stdout.write(text),
  ) {}

  onTextDelta(delta: string): void {
    if (!this.textOpen) {
      this.finishToolLine();
      this.writeOutput("\nAssistant:\n");
      this.textOpen = true;
    }

    this.writeOutput(delta);
  }

  onTextEnd(): void {
    if (this.textOpen) {
      this.writeOutput("\n");
      this.textOpen = false;
    }
  }

  onToolStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolExecutionResult,
  ): void {
    this.onTextEnd();
    const line =
      `  ${summarizeToolCall(call)} ` +
      `[${toolStatusLabel(call, status, result)}]`;

    if (process.stdout.isTTY) {
      this.writeOutput(`${this.activeToolLine ? "\r\u001b[2K" : ""}${line}`);
      this.activeToolLine = !isTerminalStatus(status);

      if (!this.activeToolLine) {
        this.writeOutput("\n");
      }

      return;
    }

    this.writeOutput(`${line}\n`);
  }

  private finishToolLine(): void {
    if (this.activeToolLine) {
      this.writeOutput("\n");
      this.activeToolLine = false;
    }
  }
}

function toolStatusLabel(
  call: ToolCall,
  status: ToolStatus,
  result?: ToolExecutionResult,
): string {
  const base = STATUS_LABELS[status];
  const count = result?.data?.count;
  if (
    call.name === "Glob" &&
    status === "succeeded" &&
    typeof count === "number"
  ) {
    return `${base}, ${count} ${count === 1 ? "match" : "matches"}`;
  }
  return base;
}

function isTerminalStatus(status: ToolStatus): boolean {
  return ["succeeded", "failed", "rejected", "denied"].includes(status);
}
