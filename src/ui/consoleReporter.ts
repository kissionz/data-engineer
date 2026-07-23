import type { AgentReporter, ToolStatus } from "../agent/reporter.js";
import type { ToolCall, ToolOutcome } from "../protocol.js";
import { summarizeToolCall } from "./toolPresentation.js";

const STATUS_LABELS: Record<ToolStatus, string> = {
  awaiting_approval: "awaiting approval",
  running: "running",
  succeeded: "done",
  failed: "failed",
  rejected: "rejected",
  denied: "denied",
};

const TOOL_SPINNER_MS = 350;
const TOOL_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export class ConsoleReporter implements AgentReporter {
  private textOpen = false;
  private toolDetailsExpanded = false;
  private toolGroupActive = false;
  private toolSpinnerFrame = 0;
  private toolSpinner?: NodeJS.Timeout;
  private readonly activeTools = new Set<string>();
  private readonly groupedTools = new Set<string>();
  private readonly incompleteTools = new Set<string>();
  private readonly toolDetails: string[] = [];
  private toolDetailCursor = 0;
  private toolGroupStartedAt = 0;
  private currentToolLabel = "Working";

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
      this.writeOutput("  Tool details hidden\n");
      return;
    }

    this.writeOutput("▾ Tool details\n");
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
    result?: ToolOutcome,
  ): void {
    this.onTextEnd();
    const line =
      `  ${summarizeToolCall(call)} ` +
      `[${toolStatusLabel(call, status, result)}]`;

    if (this.collapseTools && process.stdout.isTTY) {
      this.groupedTools.add(call.id);
      this.currentToolLabel = summarizeToolCall(call);
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
      if (status !== "succeeded") {
        this.incompleteTools.add(call.id);
      }
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
    if (this.toolGroupActive) {
      if (this.activeTools.size > 0) {
        this.stopToolSpinner();
        this.toolGroupActive = false;
        this.writeOutput(
          `\r\u001b[2K■ Stopped · ${this.activeTools.size} ${pluralize("tool", this.activeTools.size)} still active\n`,
        );
        this.resetToolGroup();
      } else {
        this.completeToolGroup();
      }
    }
  }

  private startToolGroup(): void {
    if (this.toolGroupActive) {
      return;
    }

    this.toolGroupActive = true;
    this.toolSpinnerFrame = 0;
    this.toolGroupStartedAt = Date.now();
    this.writeToolActivityLine();
    this.toolSpinner = setInterval(() => {
      if (!this.toolGroupActive) {
        return;
      }
      this.toolSpinnerFrame =
        (this.toolSpinnerFrame + 1) % TOOL_SPINNER_FRAMES.length;
      this.writeToolActivityLine();
    }, TOOL_SPINNER_MS);
  }

  private completeToolGroup(): void {
    if (!this.toolGroupActive) {
      return;
    }
    this.stopToolSpinner();
    this.toolGroupActive = false;
    const toolCount = this.groupedTools.size;
    const elapsed = formatElapsed(Date.now() - this.toolGroupStartedAt);
    const outcome = this.incompleteTools.size > 0
      ? `× ${toolCount} ${pluralize("tool", toolCount)} · ${this.incompleteTools.size} not completed`
      : `✓ ${toolCount} ${pluralize("tool", toolCount)}`;
    this.writeOutput(`\r\u001b[2K${outcome} · ${elapsed}\n`);
    this.resetToolGroup();
  }

  private writeToolActivityLine(): void {
    const frame = TOOL_SPINNER_FRAMES[this.toolSpinnerFrame];
    const active = this.activeTools.size > 1
      ? ` · ${this.activeTools.size} active`
      : "";
    const elapsed = formatElapsed(Date.now() - this.toolGroupStartedAt);
    this.writeOutput(
      `\r\u001b[2K${frame} ${this.currentToolLabel}${active} · ${elapsed}`,
    );
  }

  private stopToolSpinner(): void {
    if (this.toolSpinner) {
      clearInterval(this.toolSpinner);
      this.toolSpinner = undefined;
    }
  }

  private resetToolGroup(): void {
    this.activeTools.clear();
    this.groupedTools.clear();
    this.incompleteTools.clear();
    this.toolGroupStartedAt = 0;
    this.currentToolLabel = "Working";
  }
}

function toolStatusLabel(
  call: ToolCall,
  status: ToolStatus,
  result?: ToolOutcome,
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

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
