import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentBudgetTracker } from "../src/agent/budget.js";
import type { AgentMessage, AgentResponse } from "../src/agent/types.js";
import type { ModelClient } from "../src/model/base.js";
import type {
  CommandExecutor,
  CommandResult,
} from "../src/runtime/commandExecutor.js";
import { Workspace } from "../src/runtime/workspace.js";
import { TaskTool } from "../src/tools/task.js";

describe("TaskTool", () => {
  it("runs a reviewer with only read-only tools and an independent audit log", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "README.md"), "hello", "utf8");
    const model = new ReviewerModel("read");
    const tool = new TaskTool(
      model,
      new Workspace(root),
      unusedExecutor(),
      "parent-session",
    );

    const result = await tool.execute({
      subagent: "code-reviewer",
      task: "Review README",
    });

    expect(result).toMatchObject({
      ok: true,
      content: "No findings.",
      data: {
        subagent: "code-reviewer",
        childSessionId: expect.stringMatching(
          /^\.sub-parent-session-code-reviewer-/,
        ),
      },
    });
    expect(model.toolNames).toEqual(
      expect.arrayContaining([
        "Read",
        "Grep",
        "Glob",
        "GitStatus",
        "GitDiff",
        "SkillList",
        "SkillLoad",
      ]),
    );
    expect(model.toolNames).not.toEqual(
      expect.arrayContaining(["Write", "Edit", "Bash", "Task"]),
    );
    expect(model.firstSystemMessage).toContain("strict read-only code reviewer");

    const sessionFiles = await readdir(
      path.join(root, ".harness", "sessions"),
    );
    const childFile = sessionFiles.find((name) =>
      name.startsWith(".sub-parent-session-code-reviewer-"),
    );
    expect(childFile).toBeDefined();
    expect(
      await readFile(path.join(root, ".harness", "sessions", childFile as string), "utf8"),
    ).toContain('"type":"assistant_final"');
  });

  it("returns an unknown-tool result when the reviewer attempts to write", async () => {
    const root = await makeRoot();
    const model = new ReviewerModel("write");
    const tool = new TaskTool(
      model,
      new Workspace(root),
      unusedExecutor(),
      "parent-session",
    );

    const result = await tool.execute({
      subagent: "code-reviewer",
      task: "Try to edit a file",
    });

    expect(result).toMatchObject({ ok: true, content: "No findings." });
    expect(model.sawUnknownToolResult).toBe(true);
  });

  it("rejects unknown subagent names", async () => {
    const root = await makeRoot();
    const result = await new TaskTool(
      new ReviewerModel("read"),
      new Workspace(root),
      unusedExecutor(),
      "parent-session",
    ).execute({
      subagent: "writer",
      task: "Modify files",
    });

    expect(result).toMatchObject({
      ok: false,
      data: { reason: "invalid_subagent_task" },
    });
  });

  it("passes the parent task cancellation signal to the reviewer", async () => {
    const root = await makeRoot();
    const model = new SignalRecordingModel();
    const controller = new AbortController();
    const tool = new TaskTool(
      model,
      new Workspace(root),
      unusedExecutor(),
      "parent-session",
    );

    await tool.execute(
      {
        subagent: "code-reviewer",
        task: "Review cancellation propagation",
      },
      {
        toolCallId: "task-call",
        signal: controller.signal,
      },
    );

    expect(model.signal?.aborted).toBe(false);
    controller.abort();
    expect(model.signal?.aborted).toBe(true);
  });

  it("returns a structured cancelled result for a cancelled reviewer", async () => {
    const root = await makeRoot();
    const controller = new AbortController();
    controller.abort();
    const result = await new TaskTool(
      new SignalRecordingModel(),
      new Workspace(root),
      unusedExecutor(),
      "parent-session",
    ).execute(
      {
        subagent: "code-reviewer",
        task: "Review cancellation propagation",
      },
      {
        toolCallId: "task-call",
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      data: {
        code: "cancelled",
        retryable: false,
      },
    });
  });

  it("uses the parent task budget instead of creating a fresh child budget", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "README.md"), "hello", "utf8");
    const budget = new AgentBudgetTracker({ maxToolCalls: 1 });
    expect(budget.beginToolCall().ok).toBe(true);
    const result = await new TaskTool(
      new ReviewerModel("read"),
      new Workspace(root),
      unusedExecutor(),
      "parent-session",
    ).execute(
      {
        subagent: "code-reviewer",
        task: "Review README",
      },
      {
        toolCallId: "task-call",
        budget,
      },
    );

    expect(result.content).toBe("Stopped: tool-call budget reached.");
    expect(budget.usage.toolCalls).toBe(1);
  });
});

class ReviewerModel implements ModelClient {
  private step = 0;
  toolNames: string[] = [];
  firstSystemMessage = "";
  sawUnknownToolResult = false;

  constructor(private readonly firstAction: "read" | "write") {}

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
  }): Promise<AgentResponse> {
    this.step += 1;
    this.toolNames = options.tools.map((tool) => String(tool.name));
    this.firstSystemMessage =
      options.messages.find((message) => message.role === "system")?.content ?? "";
    this.sawUnknownToolResult ||= options.messages.some(
      (message) =>
        message.toolResult?.data?.reason === "unknown_tool",
    );

    if (this.step === 1) {
      return this.firstAction === "read"
        ? {
            toolCalls: [
              {
                id: "call-read",
                name: "Read",
                args: { file_path: "README.md" },
              },
            ],
          }
        : {
            toolCalls: [
              {
                id: "call-write",
                name: "Write",
                args: { file_path: "blocked.txt", content: "blocked" },
              },
            ],
          };
    }

    return { finalText: "No findings." };
  }
}

class SignalRecordingModel implements ModelClient {
  signal?: AbortSignal;

  async complete(options: { signal?: AbortSignal }): Promise<AgentResponse> {
    this.signal = options.signal;
    return { finalText: "No findings." };
  }
}

function unusedExecutor(): CommandExecutor {
  return {
    async run(): Promise<CommandResult> {
      throw new Error("Executor should not be called.");
    },
  };
}

function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-task-"));
}
