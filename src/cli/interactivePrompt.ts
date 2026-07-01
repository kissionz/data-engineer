import { createInterface } from "node:readline/promises";

export class InteractivePrompt {
  private rl: ReturnType<typeof createInterface>;
  private terminationPending = false;
  private activeTask?: AbortController;
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
      return;
    }

    this.rl.resume();
  }

  pauseInput(): void {
    if (this.inputSuspended) {
      return;
    }

    this.rl.close();
    this.inputSuspended = true;
  }

  beginTask(): AbortController {
    const controller = new AbortController();
    this.activeTask = controller;
    return controller;
  }

  endTask(controller: AbortController): void {
    if (this.activeTask === controller) {
      this.activeTask = undefined;
    }
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
}
