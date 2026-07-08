import {
  clearLine,
  cursorTo,
  moveCursor,
} from "node:readline";
import { createInterface as createPromisesInterface } from "node:readline/promises";

const GUIDE_PROMPT = "Guide> ";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export class InteractivePrompt {
  private rl: ReturnType<typeof createPromisesInterface>;
  private terminationPending = false;
  private activeTask?: AbortController;
  private guidanceHandler?: (text: string) => void;
  private taskLineHandler?: (line: string) => void;
  private inputSuspended = false;
  private outputLineOpen = false;
  private outputColumn = 0;

  constructor() {
    this.rl = this.createReadline();
  }

  async question(prompt: string): Promise<string> {
    return this.rl.question(`${prompt}> `);
  }

  writeAboveInput(text: string): void {
    if (!this.isGuidanceInputActive() || !process.stdout.isTTY) {
      process.stdout.write(text);
      return;
    }

    const currentLine = this.rl.line;
    const currentCursor = this.rl.cursor;

    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
    if (this.outputLineOpen) {
      moveCursor(process.stdout, 0, -1);
      cursorTo(process.stdout, this.outputColumn);
    }

    process.stdout.write(text);
    this.trackOutputPosition(text);

    if (this.outputLineOpen) {
      process.stdout.write("\n");
    }
    this.redrawGuidePrompt(currentLine, currentCursor);
  }

  resumeInput(): void {
    if (this.inputSuspended) {
      this.rl = this.createReadline();
      this.inputSuspended = false;
      this.attachTaskLineHandler();
      return;
    }

    this.rl.resume();
  }

  pauseInput(): void {
    if (this.inputSuspended) {
      return;
    }

    this.detachTaskLineHandler();
    this.rl.close();
    this.inputSuspended = true;
  }

  beginTask(onGuidance?: (text: string) => void): AbortController {
    const controller = new AbortController();
    this.activeTask = controller;
    this.resetOutputPosition();
    if (onGuidance) {
      this.guidanceHandler = onGuidance;
      this.attachTaskLineHandler();
    }
    return controller;
  }

  endTask(controller: AbortController): void {
    if (this.activeTask === controller) {
      this.activeTask = undefined;
    }
    this.guidanceHandler = undefined;
    this.detachTaskLineHandler();
    this.rl.setPrompt("");
    this.resetOutputPosition();
    this.resumeInput();
  }

  markTaskCancelled(): void {
    if (this.terminationPending) {
      return;
    }

    this.terminationPending = true;
    this.rl.write(
      "\nTask cancelled. Type y to terminate the session or n to continue. Press Ctrl+C again to exit immediately.\n",
    );
  }

  handleTerminationAnswer(
    answer: string,
  ): "none" | "exit" | "continue" | "pending" {
    if (!this.terminationPending) {
      return "none";
    }

    const normalized = answer.trim().toLowerCase();

    if (["y", "yes"].includes(normalized)) {
      return "exit";
    }

    if (["n", "no"].includes(normalized)) {
      this.terminationPending = false;
      return "continue";
    }

    return "pending";
  }

  close(): void {
    this.rl.close();
  }

  private createReadline(): ReturnType<typeof createPromisesInterface> {
    const rl = createPromisesInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.on("SIGINT", () => {
      if (this.activeTask && !this.activeTask.signal.aborted) {
        this.terminationPending = true;
        this.activeTask.abort();
        rl.write(
          "\nCancelling current task. Type y to terminate the session after cleanup, n to continue. Press Ctrl+C again to exit immediately.\n",
        );
        return;
      }

      if (this.terminationPending) {
        this.close();
        process.exit(130);
      }

      this.terminationPending = true;
      rl.write(
        "\nTerminate session? Type y to exit, n to continue. Press Ctrl+C again to exit immediately.\n",
      );
    });

    return rl;
  }

  private attachTaskLineHandler(): void {
    if (!this.activeTask || !this.guidanceHandler || this.taskLineHandler) {
      return;
    }

    this.taskLineHandler = (line) => {
      const trimmed = line.trim();

      if (!this.activeTask) {
        return;
      }

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      if (trimmed === "/cancel") {
        this.activeTask.abort();
        return;
      }

      this.guidanceHandler?.(trimmed);
      this.rl.write("Guidance queued.\n");
      this.rl.prompt();
    };
    this.rl.on("line", this.taskLineHandler);
    this.rl.setPrompt(GUIDE_PROMPT);
    this.rl.prompt();
  }

  private detachTaskLineHandler(): void {
    if (!this.taskLineHandler) {
      return;
    }

    this.rl.off("line", this.taskLineHandler);
    this.taskLineHandler = undefined;
  }

  private isGuidanceInputActive(): boolean {
    return this.activeTask !== undefined && this.guidanceHandler !== undefined;
  }

  private redrawGuidePrompt(line: string, cursor: number): void {
    process.stdout.write(`${GUIDE_PROMPT}${line}`);
    cursorTo(process.stdout, GUIDE_PROMPT.length + cursor);
  }

  private resetOutputPosition(): void {
    this.outputLineOpen = false;
    this.outputColumn = 0;
  }

  private trackOutputPosition(text: string): void {
    const columns = Math.max(1, process.stdout.columns ?? 80);
    let column = this.outputLineOpen ? this.outputColumn : 0;
    let lineOpen = this.outputLineOpen;

    for (const rawChar of stripAnsi(text)) {
      if (rawChar === "\r") {
        column = 0;
        lineOpen = true;
        continue;
      }

      if (rawChar === "\n") {
        column = 0;
        lineOpen = false;
        continue;
      }

      const width = charWidth(rawChar);
      if (width === 0) {
        continue;
      }

      column = (column + width) % columns;
      lineOpen = true;
    }

    this.outputColumn = column;
    this.outputLineOpen = lineOpen;
  }
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function charWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  );
}
