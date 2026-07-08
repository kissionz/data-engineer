import { createInterface } from "node:readline/promises";

export class InteractivePrompt {
  private rl: ReturnType<typeof createInterface>;
  private terminationPending = false;
  private activeTask?: AbortController;
  private guidanceHandler?: (text: string) => void;
  private taskLineHandler?: (line: string) => void;
  private inputSuspended = false;

  constructor() {
    this.rl = this.createReadline();
  }

  async question(prompt: string): Promise<string> {
    return this.rl.question(`${prompt}> `);
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

  private createReadline(): ReturnType<typeof createInterface> {
    const rl = createInterface({
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
    this.rl.setPrompt("Guide> ");
    this.rl.prompt();
  }

  private detachTaskLineHandler(): void {
    if (!this.taskLineHandler) {
      return;
    }

    this.rl.off("line", this.taskLineHandler);
    this.taskLineHandler = undefined;
  }
}
