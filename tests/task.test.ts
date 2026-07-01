import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentBudgetTracker } from "../src/agent/budget.js";
import { ContextBuilder } from "../src/agent/context.js";
import { AgentLoop } from "../src/agent/loop.js";
import { SessionStore } from "../src/agent/session.js";
import type { AgentMessage, AgentResponse } from "../src/agent/types.js";
import type { ModelClient } from "../src/model/base.js";
import { PermissionGate } from "../src/permissions/gate.js";
import { defaultPolicy } from "../src/permissions/policy.js";
import type {
  CommandExecutor,
  CommandResult,
} from "../src/runtime/commandExecutor.js";
import { Workspace } from "../src/runtime/workspace.js";
import {
  EphemeralTaskTool,
  TaskTool,
} from "../src/tools/task.js";
import { ToolRegistry } from "../src/tools/registry.js";

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
      expect.arrayContaining([
        "Write",
        "Edit",
        "Bash",
        "Task",
        "EphemeralTask",
      ]),
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

  it("runs a configured role with only its selected read-only tools", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, ".harness", "agents"), { recursive: true });
    await writeFile(
      path.join(root, ".harness", "agents", "docs-auditor.yaml"),
      [
        "name: docs-auditor",
        "description: Audit documentation accuracy.",
        "systemPrompt: Compare documentation with the implementation.",
        "tools:",
        "  - Read",
        "maxTurns: 3",
        "maxResultChars: 1000",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(root, "README.md"), "hello", "utf8");
    const model = new ReviewerModel("read");
    const tool = new TaskTool(
      model,
      new Workspace(root),
      unusedExecutor(),
      "parent-session",
    );

    expect(tool.inputSchema).toMatchObject({
      properties: {
        subagent: {
          enum: ["code-reviewer", "docs-auditor"],
        },
      },
    });
    const result = await tool.execute({
      subagent: "docs-auditor",
      task: "Audit README",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { subagent: "docs-auditor" },
    });
    expect(model.toolNames).toEqual(["Read"]);
    expect(model.firstSystemMessage).toContain(
      "Compare documentation with the implementation.",
    );
    expect(model.firstSystemMessage).toContain("Immutable safety rules");
  });

  it("runs and reclaims an explicitly requested ephemeral role", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "README.md"), "hello", "utf8");
    const model = new ReviewerModel("read");
    const tool = new EphemeralTaskTool(
      new TaskTool(
        model,
        new Workspace(root),
        unusedExecutor(),
        "parent-session",
      ),
    );

    const result = await tool.execute(
      {
        role: ephemeralSpec(),
        task: "Inspect README",
      },
      {
        toolCallId: "ephemeral-call",
        taskRunId: "run-1",
        explicitSubagentRequest: true,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        subagent: "temporary-analyst",
        ephemeral: true,
        reclaimed: true,
      },
    });
    expect(model.toolNames).toEqual(["Read"]);
    await expect(
      readdir(path.join(root, ".harness", "agents")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets the main model create, use, and reclaim an ephemeral role", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "README.md"), "hello", "utf8");
    const model = new AutoEphemeralModel();
    const workspace = new Workspace(root);
    const registry = new ToolRegistry();
    const taskTool = new TaskTool(
      model,
      workspace,
      unusedExecutor(),
      "parent-session",
    );
    registry.register(taskTool);
    registry.register(new EphemeralTaskTool(taskTool));
    const session = new SessionStore(
      path.join(root, ".harness", "sessions", "parent.jsonl"),
    );
    const loop = new AgentLoop(
      model,
      registry,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      session,
    );

    await expect(
      loop.run("/subagent 检查 README"),
    ).resolves.toBe("main complete");
    expect(model.childRuns).toBe(1);
    expect(model.childToolNames).toEqual(["Read"]);
    expect(
      (await session.load()).find(
        (event) =>
          event.type === "tool_result" &&
          event.name === "EphemeralTask",
      ),
    ).toMatchObject({
      type: "tool_result",
      ok: true,
      data: { ephemeral: true, reclaimed: true },
    });
    await expect(
      readdir(path.join(root, ".harness", "agents")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects ephemeral roles without an explicit current user request", async () => {
    const root = await makeRoot();
    const tool = new EphemeralTaskTool(
      new TaskTool(
        new ReviewerModel("read"),
        new Workspace(root),
        unusedExecutor(),
        "parent-session",
      ),
    );

    await expect(
      tool.execute(
        { role: ephemeralSpec(), task: "Inspect README" },
        { toolCallId: "ephemeral-call", taskRunId: "run-1" },
      ),
    ).resolves.toMatchObject({
      ok: false,
      data: { reason: "explicit_subagent_request_required" },
    });
    await expect(
      tool.execute(
        { role: ephemeralSpec(), task: "Inspect README" },
        {
          toolCallId: "historically-approved",
          taskRunId: "run-1",
          userApproved: true,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      data: { reason: "explicit_subagent_request_required" },
    });
  });

  it("validates ephemeral role schemas before execution", async () => {
    const root = await makeRoot();
    const tool = new EphemeralTaskTool(
      new TaskTool(
        new ReviewerModel("read"),
        new Workspace(root),
        unusedExecutor(),
        "parent-session",
      ),
    );
    const registry = new ToolRegistry();
    registry.register(tool);

    expect(
      registry.validate("EphemeralTask", {
        role: ephemeralSpec(),
        task: "Inspect",
      }).ok,
    ).toBe(true);
    expect(
      registry.validate("EphemeralTask", {
        role: ephemeralSpec(),
        subagent: "code-reviewer",
        task: "Inspect",
      }).ok,
    ).toBe(false);
    expect(
      registry.validate("EphemeralTask", {
        role: {
          ...ephemeralSpec(),
          tools: ["Read", "Bash"],
        },
        task: "Inspect",
      }).ok,
    ).toBe(false);
    expect(
      registry.validate("EphemeralTask", {
        role: {
          ...ephemeralSpec(),
          maxTurns: 2.5,
          tools: [],
        },
        task: "Inspect",
      }).ok,
    ).toBe(false);
  });

  it("enforces the per-user-task ephemeral role limit", async () => {
    const root = await makeRoot();
    const tool = new EphemeralTaskTool(
      new TaskTool(
        new ReviewerModel("read"),
        new Workspace(root),
        unusedExecutor(),
        "parent-session",
      ),
    );
    for (let index = 0; index < 8; index += 1) {
      await expect(
        tool.execute(
          {
            role: {
              ...ephemeralSpec(),
              name: `temporary-${index}`,
            },
            task: "Inspect",
          },
          {
            toolCallId: `call-${index}`,
            taskRunId: "same-user-task",
            explicitSubagentRequest: true,
          },
        ),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      tool.execute(
        {
          role: {
            ...ephemeralSpec(),
            name: "temporary-overflow",
          },
          task: "Inspect",
        },
        {
          toolCallId: "call-overflow",
          taskRunId: "same-user-task",
          explicitSubagentRequest: true,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      data: { reason: "ephemeral_subagent_limit_reached" },
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

  it("reclaims an ephemeral role when its task is already cancelled", async () => {
    const root = await makeRoot();
    const controller = new AbortController();
    controller.abort();
    const tool = new EphemeralTaskTool(
      new TaskTool(
        new SignalRecordingModel(),
        new Workspace(root),
        unusedExecutor(),
        "parent-session",
      ),
    );

    await expect(
      tool.execute(
        { role: ephemeralSpec(), task: "Review cancellation" },
        {
          toolCallId: "cancelled-ephemeral",
          taskRunId: "cancelled-run",
          explicitSubagentRequest: true,
          signal: controller.signal,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      data: {
        code: "cancelled",
        ephemeral: true,
        reclaimed: true,
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

  it("enforces the configured child turn limit while sharing the parent budget", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, ".harness", "agents"), { recursive: true });
    await writeFile(
      path.join(root, ".harness", "agents", "one-turn.yaml"),
      [
        "name: one-turn",
        "description: Stop after one model turn.",
        "systemPrompt: Read the requested file once.",
        "tools:",
        "  - Read",
        "maxTurns: 1",
        "maxResultChars: 1000",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(root, "README.md"), "hello", "utf8");
    const budget = new AgentBudgetTracker({ maxTurns: 10 });
    const result = await new TaskTool(
      new ReviewerModel("read"),
      new Workspace(root),
      unusedExecutor(),
      "parent-session",
    ).execute(
      {
        subagent: "one-turn",
        task: "Review README",
      },
      {
        toolCallId: "task-call",
        budget,
      },
    );

    expect(result.content).toBe("Stopped: turn budget reached.");
    expect(budget.usage.turns).toBe(1);
  });
});

function ephemeralSpec(): Record<string, unknown> {
  return {
    name: "temporary-analyst",
    description: "Analyze one requested subtask.",
    systemPrompt: "Inspect the requested files and report findings.",
    tools: ["Read"],
    maxTurns: 3,
    maxResultChars: 1_000,
  };
}

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

class AutoEphemeralModel implements ModelClient {
  private mainStep = 0;
  childRuns = 0;
  childToolNames: string[] = [];

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
  }): Promise<AgentResponse> {
    const system =
      options.messages.find((message) => message.role === "system")?.content ??
      "";
    if (system.includes("bounded read-only subagent")) {
      this.childRuns += 1;
      this.childToolNames = options.tools.map((tool) => String(tool.name));
      return { finalText: "child complete", stopReason: "end_turn" };
    }
    this.mainStep += 1;
    if (this.mainStep === 1) {
      return {
        stopReason: "tool_use",
        toolCalls: [
          {
            id: "create-ephemeral",
            name: "EphemeralTask",
            args: {
              role: ephemeralSpec(),
              task: "Inspect README",
            },
          },
        ],
      };
    }
    return { finalText: "main complete", stopReason: "end_turn" };
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
