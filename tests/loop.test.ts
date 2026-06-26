import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop.js";
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

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return {
      ok: true,
      content: `ran ${String(args.command)}`,
    };
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

  it("reuses session approval for the same bash command family", async () => {
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
    expect(approvalCount).toBe(1);
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
});
