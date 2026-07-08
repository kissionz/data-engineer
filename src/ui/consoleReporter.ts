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
  private toolDetailsExpanded = false;
  private readonly toolCalls = new Map<string, number>();
  private readonly toolDetails: string[] = [];

  constructor(
    private readonly writeOutput: (text: string) => void = (text) =>
      process.stdout.write(text),
  ) {}

  toggleToolDetails(): void {
    if (!process.stdout.isTTY || this.toolDetails.length === 0) {
      return;
    }

    this.onTextEnd();
    this.toolDetailsExpanded = !this.toolDetailsExpanded;
    if (!this.toolDetailsExpanded) {
      this.writeOutput("▸ tool details collapsed (ctrl+o or /tools to expand)\n");
      return;
    }

    this.writeOutput("▾ tool details\n");
    for (const detail of this.toolDetails.slice(-12)) {
      this.writeOutput(`${detail}\n`);
    }
  }

  onTextDelta(delta: string): void {
    if (!this.textOpen) {
      this.finishToolLine();
      this.writeOutput("\n● ");
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
      if (!isTerminalStatus(status)) {
        if (this.toolDetailsExpanded) {
          this.writeOutput(`${line}\n`);
        }
        return;
      }

      const count = (this.toolCalls.get(call.name) ?? 0) + 1;
      this.toolCalls.set(call.name, count);
      this.toolDetails.push(line);
      if (this.toolDetailsExpanded) {
        this.writeOutput(`${line}\n`);
        return;
      }

      this.writeOutput(
        `▸ called ${call.name} ${count} ${count === 1 ? "time" : "times"} ` +
          "(ctrl+o or /tools to expand)\n",
      );
      this.activeToolLine = !isTerminalStatus(status);

      if (!this.activeToolLine) {
        return;
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
