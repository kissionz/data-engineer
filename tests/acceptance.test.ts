import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../src/agent/context.js";
import { AgentLoop } from "../src/agent/loop.js";
import { SessionStore } from "../src/agent/session.js";
import type {
  AgentMessage,
  AgentResponse,
} from "../src/agent/types.js";
import type { ModelClient } from "../src/model/base.js";
import { PermissionGate } from "../src/permissions/gate.js";
import { defaultPolicy } from "../src/permissions/policy.js";
import type { CommandResult } from "../src/runtime/commandExecutor.js";
import { LocalCommandExecutor } from "../src/runtime/localExecutor.js";
import type {
  ShellExecutor,
  ShellOptions,
} from "../src/runtime/shellExecutor.js";
import { Workspace } from "../src/runtime/workspace.js";
import { BashTool } from "../src/tools/bash.js";
import { EditTool } from "../src/tools/edit.js";
import { GlobTool } from "../src/tools/glob.js";
import { ReadTool } from "../src/tools/read.js";
import { ToolRegistry } from "../src/tools/registry.js";

class ScriptedAcceptanceModel implements ModelClient {
  readonly requests: AgentMessage[][] = [];
  private index = 0;

  constructor(private readonly responses: AgentResponse[]) {}

  async complete(options: {
    messages: AgentMessage[];
  }): Promise<AgentResponse> {
    this.requests.push(options.messages);
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) {
      throw new Error("Acceptance model script was exhausted.");
    }
    return response;
  }
}

class ScriptedShell implements ShellExecutor {
  readonly scripts: string[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async runScript(options: ShellOptions): Promise<CommandResult> {
    this.scripts.push(options.script);
    const result = this.results.shift();
    if (!result) {
      throw new Error("Shell result script was exhausted.");
    }
    return result;
  }
}

function commandResult(
  ok: boolean,
  stdout: string,
  stderr = "",
): CommandResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr,
    timedOut: false,
    cancelled: false,
  };
}

async function createRuntime(
  root: string,
  model: ModelClient,
  tools: ToolRegistry,
): Promise<{ loop: AgentLoop; session: SessionStore }> {
  const session = new SessionStore(
    path.join(root, ".harness", "sessions", "acceptance.jsonl"),
  );
  return {
    loop: new AgentLoop(
      model,
      tools,
      new PermissionGate(defaultPolicy()),
      new ContextBuilder(root),
      session,
      20,
      async () => "allow_once",
    ),
    session,
  };
}

describe("development guide acceptance tasks", () => {
  it("task 1: analyzes a project through discovery and read tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-acceptance-"));
    await writeFile(path.join(root, "README.md"), "# Fixture project\n", "utf8");
    const workspace = new Workspace(root);
    const tools = new ToolRegistry();
    tools.register(new GlobTool(workspace, new LocalCommandExecutor()));
    tools.register(new ReadTool(workspace));
    const model = new ScriptedAcceptanceModel([
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "glob-1", name: "Glob", args: { pattern: "README.md" } },
        ],
      },
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "read-1", name: "Read", args: { file_path: "README.md" } },
        ],
      },
      { stopReason: "end_turn", finalText: "It is a fixture project." },
    ]);
    const { loop, session } = await createRuntime(root, model, tools);

    await expect(loop.run("What does this project do?")).resolves.toBe(
      "It is a fixture project.",
    );
    const results = (await session.load()).filter(
      (event) => event.type === "tool_result",
    );
    expect(results).toEqual([
      expect.objectContaining({ name: "Glob", ok: true }),
      expect.objectContaining({ name: "Read", ok: true }),
    ]);
    expect(model.requests.at(-1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining("Fixture project"),
        }),
      ]),
    );
  });

  it("task 2: runs tests and inspects a failing source without editing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-acceptance-"));
    const sourcePath = path.join(root, "parser.ts");
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    const workspace = new Workspace(root);
    const shell = new ScriptedShell([
      commandResult(false, "", "parser.test.ts failed"),
    ]);
    const tools = new ToolRegistry();
    tools.register(new BashTool(workspace, shell));
    tools.register(new ReadTool(workspace));
    const model = new ScriptedAcceptanceModel([
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "test-1", name: "Bash", args: { command: "npm test" } },
        ],
      },
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "read-2", name: "Read", args: { file_path: "parser.ts" } },
        ],
      },
      { stopReason: "end_turn", finalText: "The parser assertion fails." },
    ]);
    const { loop } = await createRuntime(root, model, tools);

    await expect(loop.run("Find the failing test cause.")).resolves.toBe(
      "The parser assertion fails.",
    );
    expect(shell.scripts).toEqual(["npm test"]);
    expect(await readFile(sourcePath, "utf8")).toBe(
      "export const value = 1;\n",
    );
  });

  it("task 3: makes a small exact edit and returns an observable change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-acceptance-"));
    const readmePath = path.join(root, "README.md");
    await writeFile(readmePath, "Install with npm install.\n", "utf8");
    const workspace = new Workspace(root);
    const tools = new ToolRegistry();
    tools.register(new ReadTool(workspace));
    tools.register(new EditTool(workspace));
    const model = new ScriptedAcceptanceModel([
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "read-3", name: "Read", args: { file_path: "README.md" } },
        ],
      },
      {
        stopReason: "tool_use",
        toolCalls: [
          {
            id: "edit-3",
            name: "Edit",
            args: {
              file_path: "README.md",
              old_string: "npm install",
              new_string: "pnpm install",
            },
          },
        ],
      },
      { stopReason: "end_turn", finalText: "Updated the install command." },
    ]);
    const { loop, session } = await createRuntime(root, model, tools);

    await expect(loop.run("Use pnpm in the README.")).resolves.toBe(
      "Updated the install command.",
    );
    expect(await readFile(readmePath, "utf8")).toBe(
      "Install with pnpm install.\n",
    );
    expect(
      (await session.load()).find(
        (event) => event.type === "tool_result" && event.name === "Edit",
      ),
    ).toMatchObject({
      ok: true,
      content: expect.stringContaining("+Install with pnpm install."),
    });
  });

  it("task 4: fixes a failure and reruns the test command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-acceptance-"));
    const sourcePath = path.join(root, "sum.ts");
    await writeFile(sourcePath, "export const sum = () => 1;\n", "utf8");
    const workspace = new Workspace(root);
    const shell = new ScriptedShell([
      commandResult(false, "", "expected 2, received 1"),
      commandResult(true, "tests passed"),
    ]);
    const tools = new ToolRegistry();
    tools.register(new BashTool(workspace, shell));
    tools.register(new ReadTool(workspace));
    tools.register(new EditTool(workspace));
    const model = new ScriptedAcceptanceModel([
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "test-4a", name: "Bash", args: { command: "npm test" } },
        ],
      },
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "read-4", name: "Read", args: { file_path: "sum.ts" } },
        ],
      },
      {
        stopReason: "tool_use",
        toolCalls: [
          {
            id: "edit-4",
            name: "Edit",
            args: {
              file_path: "sum.ts",
              old_string: "() => 1",
              new_string: "() => 2",
            },
          },
        ],
      },
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "test-4b", name: "Bash", args: { command: "npm test" } },
        ],
      },
      { stopReason: "end_turn", finalText: "Fixed and verified." },
    ]);
    const { loop } = await createRuntime(root, model, tools);

    await expect(loop.run("Fix the failing tests.")).resolves.toBe(
      "Fixed and verified.",
    );
    expect(shell.scripts).toEqual(["npm test", "npm test"]);
    expect(await readFile(sourcePath, "utf8")).toContain("() => 2");
  });

  it("task 5: denies a destructive command before reaching the executor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-acceptance-"));
    const workspace = new Workspace(root);
    const shell = new ScriptedShell([]);
    const tools = new ToolRegistry();
    tools.register(new BashTool(workspace, shell));
    const model = new ScriptedAcceptanceModel([
      {
        stopReason: "tool_use",
        toolCalls: [
          { id: "danger-5", name: "Bash", args: { command: "rm -rf ." } },
        ],
      },
      { stopReason: "end_turn", finalText: "The destructive command was denied." },
    ]);
    const { loop, session } = await createRuntime(root, model, tools);

    await expect(loop.run("Delete the project.")).resolves.toBe(
      "The destructive command was denied.",
    );
    expect(shell.scripts).toEqual([]);
    expect(
      (await session.load()).find(
        (event) =>
          event.type === "tool_result" && event.toolCallId === "danger-5",
      ),
    ).toMatchObject({
      ok: false,
      content: expect.stringContaining("Permission denied"),
    });
  });
});
