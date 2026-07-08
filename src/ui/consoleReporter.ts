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

const TOOL_SPINNER_MS = 350;

export class ConsoleReporter implements AgentReporter {
  private textOpen = false;
  private toolDetailsExpanded = false;
  private toolGroupActive = false;
  private toolSpinnerFrame = 0;
  private toolSpinner?: NodeJS.Timeout;
  private readonly activeTools = new Set<string>();
  private readonly toolDetails: string[] = [];
  private toolDetailCursor = 0;
  private toolGroupStartIndex = 0;

  constructor(
    private readonly writeOutput: (text: string) => void = (text) =>
      process.stdout.write(text),
    private readonly collapseTools = false,
  ) {}

  toggleToolDetails(): void {
    if (
      !this.collapseTools ||
      !process.stdout.isTTY ||
      this.toolDetails.length === 0
    ) {
      return;
    }

    this.onTextEnd();
    this.toolDetailsExpanded = !this.toolDetailsExpanded;
    if (!this.toolDetailsExpanded) {
      this.writeOutput("  tool details collapsed\n");
      return;
    }

    this.writeOutput("▾ tool details\n");
    for (const detail of this.toolDetails.slice(this.toolDetailCursor)) {
      this.writeOutput(`${detail}\n`);
    }
    this.writeOutput("\n");
    this.toolDetailCursor = this.toolDetails.length;
  }

  onTextDelta(delta: string): void {
    if (!this.textOpen) {
      this.completeToolGroup();
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

    if (this.collapseTools && process.stdout.isTTY) {
      if (!isTerminalStatus(status)) {
        this.startToolGroup();
        this.activeTools.add(call.id);
        this.toolDetails.push(line);
        if (this.toolDetailsExpanded) {
          this.writeOutput(`${line}\n`);
          this.toolDetailCursor = this.toolDetails.length;
        }
        return;
      }

      this.startToolGroup();
      this.activeTools.delete(call.id);
      this.toolDetails.push(line);
      if (this.toolDetailsExpanded) {
        this.writeOutput(`${line}\n`);
        this.toolDetailCursor = this.toolDetails.length;
      }
      return;
    }

    this.writeOutput(`${line}\n`);
  }

  dispose(): void {
    if (this.toolSpinner) {
      clearInterval(this.toolSpinner);
      this.toolSpinner = undefined;
    }
    if (this.toolGroupActive) {
      this.toolGroupActive = false;
      this.writeOutput("\r\u001b[2K▸ 已停止工具调用\n");
    }
  }

  private startToolGroup(): void {
    if (this.toolGroupActive) {
      return;
    }

    this.toolGroupActive = true;
    this.toolSpinnerFrame = 0;
    this.toolGroupStartIndex = this.toolDetails.length;
    this.writeToolActivityLine();
    this.toolSpinner = setInterval(() => {
      if (!this.toolGroupActive) {
        return;
      }
      this.toolSpinnerFrame = (this.toolSpinnerFrame + 1) % 3;
      this.writeToolActivityLine();
    }, TOOL_SPINNER_MS);
  }

  private completeToolGroup(): void {
    if (!this.toolGroupActive) {
      return;
    }
    if (this.toolSpinner) {
      clearInterval(this.toolSpinner);
      this.toolSpinner = undefined;
    }
    this.toolGroupActive = false;
    const groupCount = this.toolDetails.length - this.toolGroupStartIndex;
    this.writeOutput(
      `\r\u001b[2K▸ 已完成 ${groupCount} 个工具事件\n`,
    );
  }

  private writeToolActivityLine(): void {
    const dots = ".".repeat(this.toolSpinnerFrame + 1);
    this.writeOutput(`\r\u001b[2K▸ 处理中${dots}`);
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
