import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop.js";
import { CANCELLED_TEXT } from "../src/agent/cancellation.js";
import { ContextBuilder } from "../src/agent/context.js";
import type { AgentReporter, ToolStatus } from "../src/agent/reporter.js";
import { SessionStore } from "../src/agent/session.js";
import type {
  AgentMessage,
  AgentResponse,
  ToolCall,
} from "../src/agent/types.js";
import type { ModelClient } from "../src/model/base.js";
import { HookManager } from "../src/hooks/manager.js";
import { PermissionGate } from "../src/permissions/gate.js";
import { defaultPolicy } from "../src/permissions/policy.js";
import { Workspace } from "../src/runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "../src/tools/base.js";
import { ReadTool } from "../src/tools/read.js";
import { ToolRegistry } from "../src/tools/registry.js";

class ScriptedModel implements ModelClient {
  private step = 0;

  async complete(_options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
  }): Promise<AgentResponse> {
    this.step += 1;

    if (this.step === 1) {
      return {
        toolCalls: [
          {
            id: "call_1",
            name: "Read",
            args: { file_path: "README.md" },
          },
        ],
      };
    }

    return { finalText: "done" };
  }
}

class BashTwiceModel implements ModelClient {
  private step = 0;

  async complete(_options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
  }): Promise<AgentResponse> {
    this.step += 1;

    if (this.step === 1) {
      return {
        toolCalls: [
          {
            id: "call_1",
            name: "Bash",
            args: { command: "npm test" },
          },
        ],
      };
    }

    if (this.step === 2) {
      return {
        toolCalls: [
          {
            id: "call_2",
            name: "Bash",
            args: { command: "npm run build" },
          },
        ],
      };
    }

    return { finalText: "done" };
  }
}

class WriteThenDoneModel implements ModelClient {
  private step = 0;

  async complete(): Promise<AgentResponse> {
    this.step += 1;

    if (this.step === 1) {
      return {
        toolCalls: [
          {
            id: "call-write",
            name: "Write",
            args: { file_path: "blocked.txt", content: "content" },
          },
        ],
      };
    }

    return { finalText: "done" };
  }
}

class UnknownToolThenDoneModel implements ModelClient {
  private step = 0;

  async complete(): Promise<AgentResponse> {
    this.step += 1;

    if (this.step === 1) {
      return {
        toolCalls: [
          {
            id: "call-unknown",
            name: "MissingTool",
            args: {},
          },
        ],
      };
    }

    return { finalText: "recovered" };
  }
}

class FakeBashTool implements Tool {
  name = "Bash";
  description = "Fake bash tool for loop tests.";
  inputSchema = {
    type: "object",
    properties: {
      command: { type: "string" },
    },
    required: ["command"],
  };
  executions = 0;

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    this.executions += 1;
    return {
      ok: true,
      content: `ran ${String(args.command)}`,
    };
  }
}

class RepeatedToolCallModel implements ModelClient {
  private step = 0;

  constructor(
    private readonly first: ToolCall,
    private readonly second: ToolCall = first,
  ) {}

  async complete(): Promise<AgentResponse> {
    this.step += 1;

    if (this.step === 1) {
      return { toolCalls: [this.first, this.second] };
    }

    return { finalText: "done" };
  }
}

class ReplayAcrossTurnsModel implements ModelClient {
  private step = 0;

  constructor(private readonly call: ToolCall) {}

  async complete(): Promise<AgentResponse> {
    this.step += 1;
    return this.step <= 2
      ? { toolCalls: [this.call] }
      : { finalText: "done" };
  }
}

class SingleToolThenDoneModel implements ModelClient {
  private step = 0;

  constructor(private readonly call: ToolCall) {}

  async complete(): Promise<AgentResponse> {
    this.step += 1;
    return this.step === 1
      ? { toolCalls: [this.call] }
      : { finalText: "done" };
  }
}

class CountingWriteTool implements Tool {
  name = "Write";
  description = "Fake write tool for hook tests.";
  inputSchema = { type: "object", properties: {} };
  executions = 0;

  async execute(): Promise<ToolExecutionResult> {
    this.executions += 1;
    return { ok: true, content: "wrote" };
  }
}

class CountingGitDiffTool implements Tool {
  name = "GitDiff";
  description = "Fake git diff tool for loop tests.";
  inputSchema = { type: "object", properties: {} };
  executions = 0;

  async execute(): Promise<ToolExecutionResult> {
    this.executions += 1;
    return { ok: true, content: "diff --git a/file.txt b/file.txt" };
  }
}

class WriteThenInspectModel implements ModelClient {
  private step = 0;
  messages: AgentMessage[][] = [];

  async complete(options: {
    messages: AgentMessage[];
  }): Promise<AgentResponse> {
    this.messages.push(options.messages);
    this.step += 1;

    if (this.step === 1) {
      return {
        toolCalls: [
          {
            id: "call-write",
            name: "Write",
            args: { file_path: "file.txt", content: "content" },
          },
        ],
      };
    }

    return { finalText: "reviewed" };
  }
}

class WriteAndDiffModel implements ModelClient {
  private step = 0;

  async complete(): Promise<AgentResponse> {
    this.step += 1;

    if (this.step === 1) {
      return {
        toolCalls: [
          {
            id: "call-write",
            name: "Write",
            args: { file_path: "file.txt", content: "content" },
          },
          {
            id: "call-diff",
            name: "GitDiff",
            args: {},
          },
        ],
      };
    }

    return { finalText: "reviewed" };
  }
}

class CountingFinalModel implements ModelClient {
  calls = 0;

  async complete(): Promise<AgentResponse> {
    this.calls += 1;
    return { finalText: "done" };
  }
}

class AbortableModel implements ModelClient {
  async complete(options: { signal?: AbortSignal }): Promise<AgentResponse> {
    return new Promise((_resolve, reject) => {
      const abort = () =>
        reject(new DOMException("The operation was aborted.", "AbortError"));

      if (options.signal?.aborted) {
        abort();
        return;
      }

      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class FailingModel implements ModelClient {
  async complete(): Promise<AgentResponse> {
    throw new Error("temporary network failure");
  }
}

class TwoToolCallsModel implements ModelClient {
  async complete(): Promise<AgentResponse> {
    return {
      toolCalls: [
        { id: "call-read", name: "Read", args: {} },
        { id: "call-grep", name: "Grep", args: {} },
      ],
    };
  }
}

class CancellingReadTool implements Tool {
  name = "Read";
  description = "Cancel the parent task during execution.";
  inputSchema = { type: "object", properties: {} };

  constructor(private readonly controller: AbortController) {}

  async execute(): Promise<ToolExecutionResult> {
    this.controller.abort();
    return { ok: true, content: "read completed" };
  }
}

class CountingGrepTool implements Tool {
  name = "Grep";
  description = "Count executions after cancellation.";
  inputSchema = { type: "object", properties: {} };
  executions = 0;

  async execute(): Promise<ToolExecutionResult> {
    this.executions += 1;
    return { ok: true, content: "grep completed" };
  }
}

class RecordingReporter implements AgentReporter {
  text = "";
  statuses: ToolStatus[] = [];

  onTextDelta(delta: string): void {
    this.text += delta;
  }

  onTextEnd(): void {}

  onToolStatus(_call: ToolCall, status: ToolStatus): void {
    this.statuses.push(status);
  }
}

describe("AgentLoop", () => {
  it("continues after a tool result and persists session events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    await writeFile(path.join(root, "README.md"), "hello", "utf8");

    const tools = new ToolRegistry();
    tools.register(new ReadTool(new Workspace(root)));

    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const reporter = new RecordingReporter();
    const loop = new AgentLoop(
      new ScriptedModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
      50,
      undefined,
      reporter,
    );

    await expect(loop.run("inspect")).resolves.toBe("done");

    const sessionText = await readFile(sessionPath, "utf8");
    expect(sessionText).toContain('"type":"user_message"');
    expect(sessionText).toContain('"type":"assistant_tool_calls"');
    expect(sessionText).toContain('"type":"tool_result"');
    expect(sessionText).toContain('"type":"assistant_final"');
    expect(reporter.text).toBe("done");
    expect(reporter.statuses).toEqual(["running", "succeeded"]);
  });

  it("rechecks approval when concrete bash arguments change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const tools = new ToolRegistry();
    tools.register(new FakeBashTool());
    let approvalCount = 0;

    const loop = new AgentLoop(
      new BashTwiceModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(path.join(root, ".harness", "sessions", "test.jsonl")),
      10,
      async () => {
        approvalCount += 1;
        return "allow_session";
      },
    );

    await expect(loop.run("run npm checks")).resolves.toBe("done");
    expect(approvalCount).toBe(2);
  });

  it("executes duplicate tool call ids only once in the same response", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const bash = new FakeBashTool();
    const tools = new ToolRegistry();
    tools.register(bash);
    const call = {
      id: "same-call",
      name: "Bash",
      args: { command: "npm test" },
    };
    const loop = new AgentLoop(
      new RepeatedToolCallModel(call),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(path.join(root, ".harness", "sessions", "test.jsonl")),
      10,
      async () => "allow_once",
    );

    await expect(loop.run("run once")).resolves.toBe("done");
    expect(bash.executions).toBe(1);
    expect(await readFile(
      path.join(root, ".harness", "sessions", "test.jsonl"),
      "utf8",
    )).toContain("executed only once");
  });

  it("replays a completed tool call id across turns without executing again", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const bash = new FakeBashTool();
    const tools = new ToolRegistry();
    tools.register(bash);
    const call = {
      id: "replayed-call",
      name: "Bash",
      args: { command: "npm test" },
    };
    const loop = new AgentLoop(
      new ReplayAcrossTurnsModel(call),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(path.join(root, ".harness", "sessions", "test.jsonl")),
      10,
      async () => "allow_once",
    );

    await expect(loop.run("run once")).resolves.toBe("done");
    expect(bash.executions).toBe(1);
    expect(await readFile(
      path.join(root, ".harness", "sessions", "test.jsonl"),
      "utf8",
    )).toContain("deduplicated");
  });

  it("rejects a reused tool call id with different arguments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const bash = new FakeBashTool();
    const tools = new ToolRegistry();
    tools.register(bash);
    const loop = new AgentLoop(
      new RepeatedToolCallModel(
        { id: "collision", name: "Bash", args: { command: "npm test" } },
        { id: "collision", name: "Bash", args: { command: "npm run build" } },
      ),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(path.join(root, ".harness", "sessions", "test.jsonl")),
      10,
      async () => "allow_once",
    );

    await expect(loop.run("detect collision")).resolves.toBe("done");
    expect(bash.executions).toBe(1);
    expect(await readFile(
      path.join(root, ".harness", "sessions", "test.jsonl"),
      "utf8",
    )).toContain("tool_call_id_collision");
  });

  it("marks a started tool with no result as unknown without replaying it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const store = new SessionStore(sessionPath);
    const call = {
      id: "crashed-call",
      name: "Bash",
      args: { command: "npm publish" },
    };
    await store.append({ type: "assistant_tool_calls", toolCalls: [call] });
    await store.append({
      type: "tool_execution_started",
      toolCall: call,
      fingerprint: "persisted-fingerprint",
      effect: "side_effect",
    });
    const bash = new FakeBashTool();
    const tools = new ToolRegistry();
    tools.register(bash);
    const loop = new AgentLoop(
      new CountingFinalModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      store,
      10,
    );

    await expect(loop.run("resume safely")).resolves.toBe("done");
    expect(bash.executions).toBe(0);
    const events = await store.load();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "crashed-call",
        data: expect.objectContaining({
          code: "unknown_outcome",
          retryable: false,
        }),
      }),
    );
  });

  it("does not let an old result hide a later repeated invocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const store = new SessionStore(sessionPath);
    const call = {
      id: "legacy-duplicate",
      name: "Bash",
      args: { command: "npm publish" },
    };
    const fingerprint = testFingerprint(call);
    await store.append({ type: "assistant_tool_calls", toolCalls: [call] });
    await store.append({
      type: "tool_result",
      toolCallId: call.id,
      name: call.name,
      ok: true,
      content: "first invocation completed",
    });
    await store.append({ type: "assistant_tool_calls", toolCalls: [call] });
    await store.append({
      type: "tool_execution_started",
      toolCall: call,
      fingerprint,
      effect: "side_effect",
    });
    const bash = new FakeBashTool();
    const tools = new ToolRegistry();
    tools.register(bash);
    const loop = new AgentLoop(
      new CountingFinalModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      store,
      10,
    );

    await expect(loop.run("resume duplicate safely")).resolves.toBe("done");
    expect(bash.executions).toBe(0);
    const results = (await store.load()).filter(
      (event) =>
        event.type === "tool_result" &&
        event.toolCallId === "legacy-duplicate",
    );
    expect(results).toHaveLength(2);
    expect(results.at(-1)).toMatchObject({
      ok: false,
      data: { code: "unknown_outcome", fingerprint, retryable: false },
    });
  });

  it("resumes a pending approval before accepting the new task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const store = new SessionStore(sessionPath);
    const call = {
      id: "pending-approval",
      name: "Bash",
      args: { command: "npm test" },
    };
    const fingerprint = testFingerprint(call);
    await store.append({ type: "assistant_tool_calls", toolCalls: [call] });
    await store.append({
      type: "approval_requested",
      toolCallId: call.id,
      fingerprint,
      scope: fingerprint,
      reason: "Bash command requires approval.",
    });
    const bash = new FakeBashTool();
    const tools = new ToolRegistry();
    tools.register(bash);
    let approvals = 0;
    const loop = new AgentLoop(
      new CountingFinalModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      store,
      10,
      async () => {
        approvals += 1;
        return "allow_once";
      },
    );

    await expect(loop.run("continue after recovery")).resolves.toBe("done");
    expect(approvals).toBe(1);
    expect(bash.executions).toBe(1);
    expect(await store.load()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval_resolved",
          toolCallId: call.id,
          decision: "allow_once",
        }),
        expect.objectContaining({
          type: "tool_result",
          toolCallId: call.id,
          ok: true,
        }),
      ]),
    );
  });

  it("restores only a persisted session approval bound to its original call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const store = new SessionStore(sessionPath);
    const original = {
      id: "approved-original",
      name: "Bash",
      args: { command: "npm test" },
    };
    const fingerprint = testFingerprint(original);
    await store.append({
      type: "assistant_tool_calls",
      toolCalls: [original],
    });
    await store.append({
      type: "approval_resolved",
      toolCallId: original.id,
      fingerprint,
      scope: fingerprint,
      decision: "allow_session",
    });
    await store.append({
      type: "tool_result",
      toolCallId: original.id,
      name: original.name,
      ok: true,
      content: "previously completed",
    });
    const bash = new FakeBashTool();
    const tools = new ToolRegistry();
    tools.register(bash);
    let approvals = 0;
    const loop = new AgentLoop(
      new SingleToolThenDoneModel({
        ...original,
        id: "approved-reuse",
      }),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      store,
      10,
      async () => {
        approvals += 1;
        return "reject";
      },
    );

    await expect(loop.run("reuse exact approval")).resolves.toBe("done");
    expect(approvals).toBe(0);
    expect(bash.executions).toBe(1);
  });

  it("blocks tool execution when a BeforeToolUse hook rejects it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const writeTool = new CountingWriteTool();
    const tools = new ToolRegistry();
    tools.register(writeTool);
    const hooks = new HookManager();
    hooks.register("BeforeToolUse", () => ({
      decision: "block",
      reason: "test block",
    }));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");

    const loop = new AgentLoop(
      new WriteThenDoneModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
      10,
      undefined,
      undefined,
      undefined,
      hooks,
    );

    await expect(loop.run("write a file")).resolves.toBe("done");
    expect(writeTool.executions).toBe(0);
    expect(await readFile(sessionPath, "utf8")).toContain('"reason":"hook_blocked"');
  });

  it("returns invalid tool calls to the model without asking for approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    let approvalCount = 0;
    const loop = new AgentLoop(
      new UnknownToolThenDoneModel(),
      new ToolRegistry(),
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
      10,
      async () => {
        approvalCount += 1;
        return "allow_once";
      },
    );

    await expect(loop.run("use a missing tool")).resolves.toBe("recovered");
    expect(approvalCount).toBe(0);
    expect(await readFile(sessionPath, "utf8")).toContain(
      '"reason":"unknown_tool"',
    );
  });

  it("automatically reviews a successful edit with GitDiff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const writeTool = new CountingWriteTool();
    const diffTool = new CountingGitDiffTool();
    const tools = new ToolRegistry();
    tools.register(writeTool);
    tools.register(diffTool);
    const model = new WriteThenInspectModel();
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");

    const loop = new AgentLoop(
      model,
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
      10,
      async () => "allow_once",
    );

    await expect(loop.run("write and review")).resolves.toBe("reviewed");
    expect(diffTool.executions).toBe(1);
    expect(model.messages[1]).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("git_diff_review"),
      }),
    );
    expect(await readFile(sessionPath, "utf8")).toContain(
      '"kind":"git_diff_review"',
    );
  });

  it("does not repeat GitDiff when the model already reviewed the edit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const tools = new ToolRegistry();
    const diffTool = new CountingGitDiffTool();
    tools.register(new CountingWriteTool());
    tools.register(diffTool);

    const loop = new AgentLoop(
      new WriteAndDiffModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(path.join(root, ".harness", "sessions", "test.jsonl")),
      10,
      async () => "allow_once",
    );

    await expect(loop.run("write and review")).resolves.toBe("reviewed");
    expect(diffTool.executions).toBe(1);
  });

  it("emits AfterEdit after a successful write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const tools = new ToolRegistry();
    tools.register(new CountingWriteTool());
    const hooks = new HookManager();
    let editEvents = 0;
    let toolEvents = 0;
    hooks.register("AfterToolUse", () => {
      toolEvents += 1;
      return null;
    });
    hooks.register("AfterEdit", () => {
      editEvents += 1;
      return null;
    });

    const loop = new AgentLoop(
      new WriteThenDoneModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(path.join(root, ".harness", "sessions", "test.jsonl")),
      10,
      async () => "allow_once",
      undefined,
      undefined,
      hooks,
    );

    await expect(loop.run("write")).resolves.toBe("done");
    expect(toolEvents).toBe(1);
    expect(editEvents).toBe(1);
  });

  it("continues when BeforeAgentStop blocks the first final response", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const model = new CountingFinalModel();
    const hooks = new HookManager();
    let stopChecks = 0;
    hooks.register("BeforeAgentStop", () => {
      stopChecks += 1;
      return stopChecks === 1
        ? { decision: "block", reason: "Run required checks." }
        : null;
    });
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const reporter = new RecordingReporter();

    const loop = new AgentLoop(
      model,
      new ToolRegistry(),
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
      10,
      undefined,
      reporter,
      undefined,
      hooks,
    );

    await expect(loop.run("finish carefully")).resolves.toBe("done");
    expect(model.calls).toBe(2);
    expect(reporter.text).toBe("done");
    expect(await readFile(sessionPath, "utf8")).toContain(
      '"kind":"stop_block"',
    );
  });

  it("cancels an in-flight model request and records recoverable state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const controller = new AbortController();
    const loop = new AgentLoop(
      new AbortableModel(),
      new ToolRegistry(),
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
    );

    const running = loop.run("wait for the model", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(running).resolves.toBe(CANCELLED_TEXT);
    expect(await readFile(sessionPath, "utf8")).toContain(
      '"type":"session_cancelled"',
    );
  });

  it("records model failures without converting them to final answers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const loop = new AgentLoop(
      new FailingModel(),
      new ToolRegistry(),
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
    );

    await expect(loop.run("make a request")).rejects.toThrow(
      "temporary network failure",
    );
    const sessionText = await readFile(sessionPath, "utf8");
    expect(sessionText).toContain('"type":"session_failed"');
    expect(sessionText).not.toContain('"type":"assistant_final"');
  });

  it("records cancelled outputs for unexecuted calls in a multi-tool turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const controller = new AbortController();
    const grep = new CountingGrepTool();
    const tools = new ToolRegistry();
    tools.register(new CancellingReadTool(controller));
    tools.register(grep);
    const loop = new AgentLoop(
      new TwoToolCallsModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
    );

    await expect(
      loop.run("run two tools", controller.signal),
    ).resolves.toBe(CANCELLED_TEXT);
    expect(grep.executions).toBe(0);

    const events = await new SessionStore(sessionPath).load();
    const results = events.filter((event) => event.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results).toContainEqual(
      expect.objectContaining({
        toolCallId: "call-grep",
        ok: false,
        data: { code: "cancelled", retryable: false },
      }),
    );
  });
});

function testFingerprint(call: ToolCall): string {
  return createHash("sha256")
    .update(`${call.name}\0${JSON.stringify(call.args)}`)
    .digest("hex");
}
