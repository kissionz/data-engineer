#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { AgentLoop } from "./agent/loop.js";
import { ContextBuilder } from "./agent/context.js";
import { SessionCompactor } from "./agent/compaction.js";
import {
  SessionManager,
  type ManagedSession,
} from "./agent/sessionManager.js";
import { HookManager } from "./hooks/manager.js";
import { protectSensitiveWrites } from "./hooks/defaults.js";
import type { ModelClient } from "./model/base.js";
import { SessionStore } from "./agent/session.js";
import { MockModel } from "./model/mock.js";
import { OpenAIModel } from "./model/openai.js";
import {
  askUserApproval,
  restoreInputAfterApproval,
} from "./permissions/approval.js";
import { defaultPolicy } from "./permissions/policy.js";
import { PermissionGate } from "./permissions/gate.js";
import { loadEnvFile } from "./runtime/env.js";
import { LocalCommandExecutor } from "./runtime/localExecutor.js";
import { Workspace } from "./runtime/workspace.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { GitDiffTool, GitStatusTool } from "./tools/git.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { ReadTool } from "./tools/read.js";
import { ToolRegistry } from "./tools/registry.js";
import { TodoReadTool, TodoStore, TodoWriteTool } from "./tools/todo.js";
import { WriteTool } from "./tools/write.js";
import { ConsoleReporter } from "./ui/consoleReporter.js";

interface CliOptions {
  task?: string;
  cwd: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  maxTurns: string;
  resume?: string;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("harness")
    .description("TypeScript local coding agent harness")
    .option("-t, --task <task>", "Task to run")
    .option("--cwd <cwd>", "Workspace directory", process.cwd())
    .option("--provider <provider>", "Model provider: openai or mock", "openai")
    .option("--model <model>", "Model name")
    .option("--base-url <baseUrl>", "OpenAI-compatible API base URL")
    .option("--max-turns <turns>", "Maximum agent turns per user message", "50")
    .option("--resume <session>", "Resume a session id or latest")
    .parse();

  const opts = program.opts<CliOptions>();
  const workspaceRoot = path.resolve(opts.cwd);
  await loadEnvFile(path.join(workspaceRoot, ".env"));
  assertModelConfiguration(opts.provider);

  const workspace = new Workspace(workspaceRoot);
  const executor = new LocalCommandExecutor();
  const sessionManager = new SessionManager(workspaceRoot);
  const modelName = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1";
  const baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL;
  const maxTurns = parsePositiveInteger(opts.maxTurns, "--max-turns");
  const initialSession = await sessionManager.start(opts.resume);
  const interactivePrompt = opts.task ? undefined : new InteractivePrompt();
  const createRuntime = (session: ManagedSession): SessionRuntime => ({
    session,
    agent: createAgent({
      session,
      workspaceRoot,
      workspace,
      executor,
      provider: opts.provider,
      modelName,
      baseUrl,
      maxTurns,
      interactivePrompt,
    }),
  });
  const runtime = createRuntime(initialSession);

  if (opts.task || !interactivePrompt) {
    if (!opts.task) {
      throw new Error("Task is required when interactive input is unavailable.");
    }

    console.log(`Session: ${runtime.session.id}`);
    await runTask(runtime.agent, opts.task);
    return;
  }

  await runInteractiveSession(
    runtime,
    interactivePrompt,
    sessionManager,
    createRuntime,
  );
}

interface SessionRuntime {
  session: ManagedSession;
  agent: AgentLoop;
}

interface CreateAgentOptions {
  session: ManagedSession;
  workspaceRoot: string;
  workspace: Workspace;
  executor: LocalCommandExecutor;
  provider: string;
  modelName: string;
  baseUrl?: string;
  maxTurns: number;
  interactivePrompt?: InteractivePrompt;
}

function createAgent(options: CreateAgentOptions): AgentLoop {
  const tools = new ToolRegistry();
  const todoStore = new TodoStore(options.session.todoPath);
  const sessionStore = new SessionStore(options.session.sessionPath);
  const hooks = new HookManager();
  hooks.register("BeforeToolUse", protectSensitiveWrites);

  tools.register(new ReadTool(options.workspace));
  tools.register(new GrepTool(options.workspace, options.executor));
  tools.register(new GlobTool(options.workspace, options.executor));
  tools.register(new WriteTool(options.workspace));
  tools.register(new EditTool(options.workspace));
  tools.register(new BashTool(options.workspace, options.executor));
  tools.register(new GitStatusTool(options.workspace, options.executor));
  tools.register(new GitDiffTool(options.workspace, options.executor));
  tools.register(new TodoReadTool(todoStore));
  tools.register(new TodoWriteTool(todoStore));

  return new AgentLoop(
    createModel(options.provider, options.modelName, options.baseUrl),
    tools,
    new PermissionGate(defaultPolicy()),
    new ContextBuilder(options.workspaceRoot),
    sessionStore,
    options.maxTurns,
    options.interactivePrompt
      ? restoreInputAfterApproval(askUserApproval, () =>
          options.interactivePrompt?.resumeInput(),
        )
      : askUserApproval,
    new ConsoleReporter(),
    new SessionCompactor(sessionStore),
    hooks,
  );
}

async function runTask(agent: AgentLoop, task: string): Promise<void> {
  await agent.run(task);
}

async function runInteractiveSession(
  initialRuntime: SessionRuntime,
  prompt: InteractivePrompt,
  sessionManager: SessionManager,
  createRuntime: (session: ManagedSession) => SessionRuntime,
): Promise<void> {
  let runtime = initialRuntime;
  console.log(`Interactive harness session started. Session: ${runtime.session.id}`);
  console.log("Commands: /new, /resume <id>, /session, /sessions, /exit");

  try {
    while (true) {
      const task = await prompt.question("You ");

      if (prompt.shouldExitFromAnswer(task)) {
        console.log("Bye.");
        return;
      }

      const trimmed = task.trim();

      if (!trimmed) {
        continue;
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        console.log("Bye.");
        return;
      }

      if (trimmed === "/new") {
        runtime = createRuntime(await sessionManager.create());
        console.log(`New session: ${runtime.session.id}`);
        continue;
      }

      if (trimmed === "/session") {
        console.log(`Session: ${runtime.session.id}`);
        continue;
      }

      if (trimmed === "/sessions") {
        const sessions = await sessionManager.list();
        console.log(sessions.length > 0 ? sessions.join("\n") : "[No sessions]");
        continue;
      }

      if (trimmed === "/resume") {
        console.log("Usage: /resume <session-id|latest>");
        continue;
      }

      if (trimmed.startsWith("/resume ")) {
        const sessionId = trimmed.slice("/resume ".length).trim();
        runtime = createRuntime(await sessionManager.resume(sessionId));
        console.log(`Resumed session: ${runtime.session.id}`);
        continue;
      }

      await runTask(runtime.agent, trimmed);
    }
  } finally {
    prompt.close();
  }
}

function createModel(
  provider: string,
  model: string,
  baseUrl: string | undefined,
): ModelClient {
  assertModelConfiguration(provider);

  if (provider === "mock") {
    return new MockModel();
  }

  return new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY as string,
    model,
    baseUrl,
  });
}

function assertModelConfiguration(provider: string): void {
  if (provider !== "openai" && provider !== "mock") {
    throw new Error(`Unknown provider: ${provider}`);
  }

  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error(
      [
        "OPENAI_API_KEY is required for real model use.",
        "",
        "Set up your local environment:",
        "  1. cp .env.example .env",
        "  2. edit .env and set OPENAI_API_KEY=sk-...",
        "  3. npm start -- --task \"Inspect this project\"",
        "",
        "For loop-only development without an API call, run:",
        "  npm start -- --provider mock --task \"Inspect README.md\"",
      ].join("\n"),
    );
  }
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

class InteractivePrompt {
  private readonly rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  private terminationPending = false;

  constructor() {
    this.rl.on("SIGINT", () => {
      if (this.terminationPending) {
        this.close();
        process.exit(130);
      }

      this.terminationPending = true;
      this.rl.write(
        "\nTerminate session? Type y to exit, n to continue. Press Ctrl+C again to exit immediately.\n",
      );
    });
  }

  async question(prompt: string): Promise<string> {
    return this.rl.question(`${prompt}> `);
  }

  resumeInput(): void {
    this.rl.resume();
  }

  shouldExitFromAnswer(answer: string): boolean {
    if (!this.terminationPending) {
      return false;
    }

    const normalized = answer.trim().toLowerCase();

    if (["y", "yes"].includes(normalized)) {
      return true;
    }

    if (normalized === "") {
      return false;
    }

    this.terminationPending = false;
    return false;
  }

  close(): void {
    this.rl.close();
  }
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
