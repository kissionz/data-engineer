import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionBackgroundTasks } from "../src/agent/backgroundTasks.js";
import { SessionStore } from "../src/agent/session.js";
import {
  BackgroundCommandManager,
} from "../src/runtime/backgroundCommands.js";
import type {
  ShellExecutor,
  ShellOptions,
} from "../src/runtime/shellExecutor.js";
import { Workspace } from "../src/runtime/workspace.js";
import { BashTool } from "../src/tools/bash.js";
import { BashTaskTool } from "../src/tools/bashTask.js";
import { registerBashRuntime } from "../src/tools/bashRuntime.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("background commands", () => {
  it("starts through Bash and exposes bounded progress through BashTask", async () => {
    const root = await makeRoot();
    const shell = new ControlledShellExecutor();
    const session = new SessionStore(
      path.join(root, "session.jsonl"),
      "background-session",
    );
    const tasks = createSessionBackgroundTasks(shell, session);
    const tools = new ToolRegistry();
    registerBashRuntime(tools, new Workspace(root), shell, tasks);

    const started = await tools.execute(
      "Bash",
      { command: "npm test", background: true },
      { toolCallId: "start" },
    );
    const taskId = String(started.data?.taskId);

    expect(started).toMatchObject({
      ok: true,
      data: { background: true, status: "running" },
    });
    expect(shell.options?.cwd).toBe(root);
    expect(shell.options?.script).toBe("npm test");

    const running = await tools.execute(
      "BashTask",
      { task_id: taskId },
      { toolCallId: "inspect" },
    );
    expect(running).toMatchObject({
      ok: true,
      data: { status: "running", terminal: false },
    });
    expect(running.content).toContain("tests running");

    shell.complete({
      ok: true,
      exitCode: 0,
      stdout: "all tests passed",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
    });
    const completed = await tools.execute(
      "BashTask",
      { task_id: taskId, wait_seconds: 1 },
      { toolCallId: "wait" },
    );

    expect(completed).toMatchObject({
      ok: true,
      data: { status: "completed", terminal: true, exitCode: 0 },
    });
    expect(completed.content).toContain("all tests passed");
    const transitions = (await session.load()).filter(
      (event) => event.type === "background_task_status",
    );
    expect(transitions.map((item) => item.status)).toEqual([
      "running",
      "completed",
    ]);
    await tasks.dispose();
  });

  it("stops only the requested session-owned task", async () => {
    const root = await makeRoot();
    const shell = new ControlledShellExecutor();
    const tasks = new BackgroundCommandManager(shell);
    const bash = new BashTool(new Workspace(root), shell, tasks);
    const control = new BashTaskTool(tasks);
    const started = await bash.execute({
      command: "npm run dev",
      background: true,
    });

    const stopped = await control.execute({
      task_id: String(started.data?.taskId),
      stop: true,
    });

    expect(shell.options?.signal?.aborted).toBe(true);
    expect(stopped).toMatchObject({
      ok: true,
      data: { status: "cancelled", terminal: true },
    });
    await expect(
      control.execute({ task_id: "not-owned-by-this-session" }),
    ).resolves.toMatchObject({
      ok: false,
      data: { code: "unknown_background_task" },
    });
    await tasks.dispose();
  });

  it("keeps foreground Bash on the existing execution path", async () => {
    const root = await makeRoot();
    const shell: ShellExecutor = {
      async runScript() {
        return {
          ok: true,
          exitCode: 0,
          stdout: "foreground",
          stderr: "",
          timedOut: false,
          cancelled: false,
        };
      },
    };
    const bash = new BashTool(new Workspace(root), shell);

    await expect(bash.execute({ command: "pwd" })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("foreground"),
    });
    await expect(
      bash.execute({ command: "pwd", background: true }),
    ).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("unavailable"),
    });
  });
});

class ControlledShellExecutor implements ShellExecutor {
  options?: ShellOptions;
  private resolve?: (result: Awaited<ReturnType<ShellExecutor["runScript"]>>) => void;
  private settled = false;

  runScript(
    options: ShellOptions,
  ): Promise<Awaited<ReturnType<ShellExecutor["runScript"]>>> {
    this.options = options;
    options.onProgress?.({
      stdout: "tests running",
      stderr: "",
      outputTruncated: false,
    });
    return new Promise((resolve) => {
      this.resolve = resolve;
      options.signal?.addEventListener(
        "abort",
        () => {
          this.complete({
            ok: false,
            exitCode: null,
            stdout: "tests running",
            stderr: "",
            timedOut: false,
            cancelled: true,
            outputTruncated: false,
          });
        },
        { once: true },
      );
    });
  }

  complete(result: Awaited<ReturnType<ShellExecutor["runScript"]>>): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve?.(result);
  }
}

function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "montane-background-"));
}
