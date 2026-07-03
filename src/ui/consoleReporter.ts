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

  onTextDelta(delta: string): void {
    if (!this.textOpen) {
      this.finishToolLine();
      process.stdout.write("\nAssistant:\n");
      this.textOpen = true;
    }

    process.stdout.write(delta);
  }

  onTextEnd(): void {
    if (this.textOpen) {
      process.stdout.write("\n");
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
      process.stdout.write(`${this.activeToolLine ? "\r\u001b[2K" : ""}${line}`);
      this.activeToolLine = !isTerminalStatus(status);

      if (!this.activeToolLine) {
        process.stdout.write("\n");
      }

      return;
    }

    process.stdout.write(`${line}\n`);
  }

  private finishToolLine(): void {
    if (this.activeToolLine) {
      process.stdout.write("\n");
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
