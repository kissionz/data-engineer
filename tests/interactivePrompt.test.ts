import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractivePrompt } from "../src/cli/interactivePrompt.js";

describe("InteractivePrompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles task guidance, tool toggles, cancellation, and input lifecycle", () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const prompt = new InteractivePrompt();
    const toggleDetails = vi.fn();
    const guidance = vi.fn();
    prompt.setToggleDetailsHandler(toggleDetails);

    prompt.showSubmittedUserMessage("inspect the parser");
    prompt.writeAboveInput("working\n");
    prompt.pauseInput();
    prompt.pauseInput();
    prompt.resumeInput();

    const controller = prompt.beginTask(guidance);
    const readline = prompt as unknown as {
      rl: { emit(event: string, value: string): void };
    };
    readline.rl.emit("line", "   ");
    readline.rl.emit("line", "/tools");
    readline.rl.emit("line", "  focus on edge cases  ");

    expect(toggleDetails).toHaveBeenCalledOnce();
    expect(guidance).toHaveBeenCalledWith("focus on edge cases");
    expect(output.join("")).toContain("inspect the parser");
    expect(output.join("")).toContain("↳ queued");

    readline.rl.emit("line", "/cancel");
    expect(controller.signal.aborted).toBe(true);
    prompt.endTask(controller);
    prompt.close();
  });

  it("tracks the complete termination confirmation state machine", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prompt = new InteractivePrompt();

    expect(prompt.handleTerminationAnswer("yes")).toBe("none");
    prompt.markTaskCancelled();
    prompt.markTaskCancelled();
    expect(prompt.handleTerminationAnswer("later")).toBe("pending");
    expect(prompt.handleTerminationAnswer(" NO ")).toBe("continue");
    expect(prompt.handleTerminationAnswer("n")).toBe("none");

    prompt.markTaskCancelled();
    expect(prompt.handleTerminationAnswer("YES")).toBe("exit");
    prompt.close();
  });

  it("only clears the currently active task controller", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prompt = new InteractivePrompt();
    const active = prompt.beginTask();
    const unrelated = new AbortController();

    prompt.endTask(unrelated);
    active.abort();
    prompt.endTask(active);
    prompt.resumeInput();
    prompt.close();
  });
});
