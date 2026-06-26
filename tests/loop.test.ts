import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop.js";
import { ContextBuilder } from "../src/agent/context.js";
import { SessionStore } from "../src/agent/session.js";
import type { AgentMessage, AgentResponse } from "../src/agent/types.js";
import type { ModelClient } from "../src/model/base.js";
import { PermissionGate } from "../src/permissions/gate.js";
import { defaultPolicy } from "../src/permissions/policy.js";
import { Workspace } from "../src/runtime/workspace.js";
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

describe("AgentLoop", () => {
  it("continues after a tool result and persists session events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-loop-"));
    await writeFile(path.join(root, "README.md"), "hello", "utf8");

    const tools = new ToolRegistry();
    tools.register(new ReadTool(new Workspace(root)));

    const sessionPath = path.join(root, ".harness", "sessions", "test.jsonl");
    const loop = new AgentLoop(
      new ScriptedModel(),
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      new SessionStore(sessionPath),
    );

    await expect(loop.run("inspect")).resolves.toBe("done");

    const sessionText = await readFile(sessionPath, "utf8");
    expect(sessionText).toContain('"type":"user_message"');
    expect(sessionText).toContain('"type":"assistant_tool_calls"');
    expect(sessionText).toContain('"type":"tool_result"');
    expect(sessionText).toContain('"type":"assistant_final"');
  });
});
