import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBuilder } from "../agent/context.js";
import { AgentLoop } from "../agent/loop.js";
import { SessionStore } from "../agent/session.js";
import type {
  AgentMessage,
  AgentResponse,
} from "../agent/types.js";
import type { ModelClient } from "../model/base.js";
import { PermissionGate } from "../permissions/gate.js";
import { defaultPolicy } from "../permissions/policy.js";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "../runtime/commandExecutor.js";
import type {
  ShellExecutor,
  ShellOptions,
} from "../runtime/shellExecutor.js";
import { Workspace } from "../runtime/workspace.js";
import { BashTool } from "../tools/bash.js";
import { EditTool } from "../tools/edit.js";
import { GlobTool } from "../tools/glob.js";
import { ReadTool } from "../tools/read.js";
import { ToolRegistry } from "../tools/registry.js";
import type { EvalScenario } from "./schema.js";

class EvalAssertionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvalAssertionError";
  }
}

class ScriptedEvalModel implements ModelClient {
  private index = 0;

  constructor(private readonly responses: AgentResponse[]) {}

  async complete(_options: {
    messages: AgentMessage[];
  }): Promise<AgentResponse> {
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) {
      throw new EvalAssertionError("model_script_exhausted");
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
      throw new EvalAssertionError("shell_script_exhausted");
    }
    return result;
  }
}

class FixtureCommandExecutor implements CommandExecutor {
  async run(_options: CommandOptions): Promise<CommandResult> {
    return commandResult(true, "README.md\n");
  }
}

export async function runScenario(scenario: EvalScenario): Promise<void> {
  const root = await fixtureRoot();
  try {
    switch (scenario) {
      case "project_analysis":
        return await runProjectAnalysis(root);
      case "failure_diagnosis":
        return await runFailureDiagnosis(root);
      case "exact_edit":
        return await runExactEdit(root);
      case "fix_and_verify":
        return await runFixAndVerify(root);
      case "destructive_command_denied":
        return await runDestructiveCommandDenied(root);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function evalFailureCode(error: unknown): string {
  return error instanceof EvalAssertionError
    ? error.code
    : "scenario_runner_error";
}

async function runProjectAnalysis(root: string): Promise<void> {
  await writeFile(path.join(root, "README.md"), "# Fixture project\n", "utf8");
  const workspace = new Workspace(root);
  const tools = new ToolRegistry();
  tools.register(new GlobTool(workspace, new FixtureCommandExecutor()));
  tools.register(new ReadTool(workspace));
  const model = new ScriptedEvalModel([
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
    { stopReason: "end_turn", finalText: "analysis complete" },
  ]);
  const { loop, session } = createRuntime(root, model, tools);

  assertEqual(await loop.run("analyze fixture"), "analysis complete", "wrong_final");
  const results = (await session.load()).filter(
    (event) => event.type === "tool_result",
  );
  assert(
    results.length === 2 &&
      results[0]?.name === "Glob" &&
      results[0].ok &&
      results[1]?.name === "Read" &&
      results[1].ok,
    "analysis_tool_flow_failed",
  );
}

async function runFailureDiagnosis(root: string): Promise<void> {
  const sourcePath = path.join(root, "parser.ts");
  const original = "export const value = 1;\n";
  await writeFile(sourcePath, original, "utf8");
  const workspace = new Workspace(root);
  const shell = new ScriptedShell([
    commandResult(false, "", "fixture test failed"),
  ]);
  const tools = new ToolRegistry();
  tools.register(new BashTool(workspace, shell));
  tools.register(new ReadTool(workspace));
  const model = new ScriptedEvalModel([
    {
      stopReason: "tool_use",
      toolCalls: [
        { id: "test-1", name: "Bash", args: { command: "npm test" } },
      ],
    },
    {
      stopReason: "tool_use",
      toolCalls: [
        { id: "read-1", name: "Read", args: { file_path: "parser.ts" } },
      ],
    },
    { stopReason: "end_turn", finalText: "diagnosis complete" },
  ]);
  const { loop } = createRuntime(root, model, tools);

  assertEqual(await loop.run("diagnose fixture"), "diagnosis complete", "wrong_final");
  assertEqual(shell.scripts.join(","), "npm test", "wrong_command_flow");
  assertEqual(await readFile(sourcePath, "utf8"), original, "unexpected_edit");
}

async function runExactEdit(root: string): Promise<void> {
  const readmePath = path.join(root, "README.md");
  await writeFile(readmePath, "Install with npm install.\n", "utf8");
  const workspace = new Workspace(root);
  const tools = new ToolRegistry();
  tools.register(new ReadTool(workspace));
  tools.register(new EditTool(workspace));
  const model = new ScriptedEvalModel([
    {
      stopReason: "tool_use",
      toolCalls: [
        { id: "read-1", name: "Read", args: { file_path: "README.md" } },
      ],
    },
    {
      stopReason: "tool_use",
      toolCalls: [
        {
          id: "edit-1",
          name: "Edit",
          args: {
            file_path: "README.md",
            old_string: "npm install",
            new_string: "pnpm install",
          },
        },
      ],
    },
    { stopReason: "end_turn", finalText: "edit complete" },
  ]);
  const { loop } = createRuntime(root, model, tools);

  assertEqual(await loop.run("edit fixture"), "edit complete", "wrong_final");
  assertEqual(
    await readFile(readmePath, "utf8"),
    "Install with pnpm install.\n",
    "exact_edit_failed",
  );
}

async function runFixAndVerify(root: string): Promise<void> {
  const sourcePath = path.join(root, "sum.ts");
  await writeFile(sourcePath, "export const sum = () => 1;\n", "utf8");
  const workspace = new Workspace(root);
  const shell = new ScriptedShell([
    commandResult(false, "", "expected 2"),
    commandResult(true, "tests passed"),
  ]);
  const tools = new ToolRegistry();
  tools.register(new BashTool(workspace, shell));
  tools.register(new ReadTool(workspace));
  tools.register(new EditTool(workspace));
  const model = new ScriptedEvalModel([
    {
      stopReason: "tool_use",
      toolCalls: [
        { id: "test-1", name: "Bash", args: { command: "npm test" } },
      ],
    },
    {
      stopReason: "tool_use",
      toolCalls: [
        { id: "read-1", name: "Read", args: { file_path: "sum.ts" } },
      ],
    },
    {
      stopReason: "tool_use",
      toolCalls: [
        {
          id: "edit-1",
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
        { id: "test-2", name: "Bash", args: { command: "npm test" } },
      ],
    },
    { stopReason: "end_turn", finalText: "fix verified" },
  ]);
  const { loop } = createRuntime(root, model, tools);

  assertEqual(await loop.run("fix fixture"), "fix verified", "wrong_final");
  assertEqual(
    shell.scripts.join(","),
    "npm test,npm test",
    "verification_not_rerun",
  );
  assert(
    (await readFile(sourcePath, "utf8")).includes("() => 2"),
    "fix_not_applied",
  );
}

async function runDestructiveCommandDenied(root: string): Promise<void> {
  const workspace = new Workspace(root);
  const shell = new ScriptedShell([]);
  const tools = new ToolRegistry();
  tools.register(new BashTool(workspace, shell));
  const model = new ScriptedEvalModel([
    {
      stopReason: "tool_use",
      toolCalls: [
        { id: "danger-1", name: "Bash", args: { command: "rm -rf ." } },
      ],
    },
    { stopReason: "end_turn", finalText: "command denied" },
  ]);
  const { loop, session } = createRuntime(root, model, tools);

  assertEqual(await loop.run("deny fixture"), "command denied", "wrong_final");
  assert(shell.scripts.length === 0, "destructive_command_executed");
  const denied = (await session.load()).find(
    (event) =>
      event.type === "tool_result" && event.toolCallId === "danger-1",
  );
  assert(
    denied?.type === "tool_result" &&
      !denied.ok &&
      denied.content.includes("Permission denied"),
    "destructive_command_not_denied",
  );
}

function createRuntime(
  root: string,
  model: ModelClient,
  tools: ToolRegistry,
): { loop: AgentLoop; session: SessionStore } {
  const session = new SessionStore(
    path.join(root, ".harness", "sessions", "eval.jsonl"),
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

async function fixtureRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-eval-"));
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

function assert(value: boolean, code: string): asserts value {
  if (!value) {
    throw new EvalAssertionError(code);
  }
}

function assertEqual(
  actual: string,
  expected: string,
  code: string,
): void {
  assert(actual === expected, code);
}
