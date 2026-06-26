import type { AgentReporter, ToolStatus } from "../agent/reporter.js";
import type { ToolCall } from "../agent/types.js";
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

  onToolStatus(call: ToolCall, status: ToolStatus): void {
    this.onTextEnd();
    const line = `  ${summarizeToolCall(call)} [${STATUS_LABELS[status]}]`;

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

function isTerminalStatus(status: ToolStatus): boolean {
  return ["succeeded", "failed", "rejected", "denied"].includes(status);
}
