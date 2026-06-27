#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { AgentLoop } from "./agent/loop.js";
import { CANCELLED_TEXT } from "./agent/cancellation.js";
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
import { DockerAvailabilityChecker } from "./runtime/dockerAvailability.js";
import { DockerShellExecutor } from "./runtime/dockerShellExecutor.js";
import { LocalCommandExecutor } from "./runtime/localExecutor.js";
import { LocalShellExecutor } from "./runtime/localShellExecutor.js";
import {
  parseSandboxConfig,
  type SandboxConfig,
} from "./runtime/sandboxConfig.js";
import type { ShellExecutor } from "./runtime/shellExecutor.js";
import { Workspace } from "./runtime/workspace.js";
import { WorktreeManager, type WorktreeInfo } from "./runtime/worktree.js";
import { SkillLoader } from "./skills/loader.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { GitDiffTool, GitStatusTool } from "./tools/git.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { ReadTool } from "./tools/read.js";
import { SkillListTool, SkillLoadTool } from "./tools/skill.js";
import { TaskTool } from "./tools/task.js";
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
  bashSandbox: string;
  sandboxImage: string;
  sandboxPull: string;
  sandboxNetwork: string;
  sandboxMemory: string;
  sandboxCpus: string;
  sandboxPids: string;
  worktree: boolean;
  worktreeBase: string;
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
    .option(
      "--bash-sandbox <mode>",
      "Bash execution: auto, docker, host, or off",
      "auto",
    )
    .option(
      "--sandbox-image <image>",
      "Docker sandbox image",
      "node:22-bookworm",
    )
    .option("--sandbox-pull <policy>", "Image pull: missing or never", "never")
    .option("--sandbox-network <mode>", "Container network: none or bridge", "none")
    .option("--sandbox-memory <limit>", "Container memory limit", "1g")
    .option("--sandbox-cpus <count>", "Container CPU limit", "2")
    .option("--sandbox-pids <count>", "Container process limit", "256")
    .option("--worktree", "Run the agent in a new isolated git worktree")
    .option("--worktree-base <ref>", "Git ref used for a new worktree", "HEAD")
    .parse();

  const opts = program.opts<CliOptions>();
  const sourceWorkspaceRoot = path.resolve(opts.cwd);
  await loadEnvFile(path.join(sourceWorkspaceRoot, ".env"));
  assertModelConfiguration(opts.provider);

  const executor = new LocalCommandExecutor();
  let worktree: WorktreeInfo | undefined;

  if (opts.worktree) {
    if (opts.resume) {
      throw new Error(
        "--worktree cannot be combined with --resume. Resume an existing worktree with --cwd instead.",
      );
    }

    worktree = await new WorktreeManager(
      executor,
      sourceWorkspaceRoot,
    ).create(opts.worktreeBase);
    console.log(`Worktree: ${worktree.path}`);
    console.log(`Branch: ${worktree.branch}`);
  }

  const workspaceRoot = worktree?.path ?? sourceWorkspaceRoot;
  const workspace = new Workspace(workspaceRoot);
  const sandboxConfig = parseSandboxConfig({
    mode: optionOrEnv(
      program,
      "bashSandbox",
      opts.bashSandbox,
      "HARNESS_BASH_SANDBOX",
    ),
    image: optionOrEnv(
      program,
      "sandboxImage",
      opts.sandboxImage,
      "HARNESS_SANDBOX_IMAGE",
    ),
    pull: optionOrEnv(
      program,
      "sandboxPull",
      opts.sandboxPull,
      "HARNESS_SANDBOX_PULL",
    ),
    network: optionOrEnv(
      program,
      "sandboxNetwork",
      opts.sandboxNetwork,
      "HARNESS_SANDBOX_NETWORK",
    ),
    memory: optionOrEnv(
      program,
      "sandboxMemory",
      opts.sandboxMemory,
      "HARNESS_SANDBOX_MEMORY",
    ),
    cpus: optionOrEnv(
      program,
      "sandboxCpus",
      opts.sandboxCpus,
      "HARNESS_SANDBOX_CPUS",
    ),
    pids: optionOrEnv(
      program,
      "sandboxPids",
      opts.sandboxPids,
      "HARNESS_SANDBOX_PIDS",
    ),
  });
  const shellExecutorFactory = await createShellExecutorFactory(
    sandboxConfig,
    executor,
    workspace,
  );
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
      shellExecutor: shellExecutorFactory(session),
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
    try {
      await runSingleTask(runtime.agent, opts.task);
    } finally {
      await runtime.session.release();
    }
    printWorktreeReminder(worktree);
    return;
  }

  await runInteractiveSession(
    runtime,
    interactivePrompt,
    sessionManager,
    createRuntime,
  );
  printWorktreeReminder(worktree);
}

function optionOrEnv(
  program: Command,
  optionName: string,
  optionValue: string,
  environmentName: string,
): string {
  return program.getOptionValueSource(optionName) === "default"
    ? process.env[environmentName] ?? optionValue
    : optionValue;
}

interface SessionRuntime {
  session: ManagedSession;
  agent: AgentLoop;
}

type ShellExecutorFactory = (
  session: ManagedSession,
) => ShellExecutor | undefined;

interface CreateAgentOptions {
  session: ManagedSession;
  workspaceRoot: string;
  workspace: Workspace;
  executor: LocalCommandExecutor;
  shellExecutor?: ShellExecutor;
  provider: string;
  modelName: string;
  baseUrl?: string;
  maxTurns: number;
  interactivePrompt?: InteractivePrompt;
}

async function createShellExecutorFactory(
  config: SandboxConfig,
  executor: LocalCommandExecutor,
  workspace: Workspace,
): Promise<ShellExecutorFactory> {
  if (config.mode === "off") {
    return () => undefined;
  }

  if (config.mode === "host") {
    const local = new LocalShellExecutor(executor);
    return () => local;
  }

  const availability = await new DockerAvailabilityChecker(executor).check(
    workspace.root,
    config,
  );

  if (!availability.available) {
    if (config.mode === "docker") {
      throw new Error(`Docker sandbox is unavailable: ${availability.reason}`);
    }

    console.warn(
      [
        `Bash tool disabled: ${availability.reason}`,
        "Start Docker or explicitly use --bash-sandbox host to run Bash on the host.",
      ].join("\n"),
    );
    return () => undefined;
  }

  return (session) =>
    new DockerShellExecutor(
      executor,
      workspace,
      session.id,
      config,
    );
}

function createAgent(options: CreateAgentOptions): AgentLoop {
  const tools = new ToolRegistry();
  const model = createModel(
    options.provider,
    options.modelName,
    options.baseUrl,
  );
  const todoStore = new TodoStore(options.session.todoPath);
  const sessionStore = new SessionStore(options.session.sessionPath);
  const hooks = new HookManager();
  const skillLoader = new SkillLoader(options.workspace);
  hooks.register("BeforeToolUse", protectSensitiveWrites);

  tools.register(new ReadTool(options.workspace));
  tools.register(new GrepTool(options.workspace, options.executor));
  tools.register(new GlobTool(options.workspace, options.executor));
  tools.register(new WriteTool(options.workspace));
  tools.register(new EditTool(options.workspace));
  if (options.shellExecutor) {
    tools.register(new BashTool(options.workspace, options.shellExecutor));
  }
  tools.register(new GitStatusTool(options.workspace, options.executor));
  tools.register(new GitDiffTool(options.workspace, options.executor));
  tools.register(new TodoReadTool(todoStore));
  tools.register(new TodoWriteTool(todoStore));
  tools.register(new SkillListTool(skillLoader));
  tools.register(new SkillLoadTool(skillLoader));
  tools.register(
    new TaskTool(
      model,
      options.workspace,
      options.executor,
      options.session.id,
    ),
  );

  return new AgentLoop(
    model,
    tools,
    new PermissionGate(defaultPolicy()),
    new ContextBuilder(options.workspaceRoot),
    sessionStore,
    options.maxTurns,
    options.interactivePrompt
      ? restoreInputAfterApproval(
          askUserApproval,
          () => options.interactivePrompt?.resumeInput(),
          () => options.interactivePrompt?.pauseInput(),
        )
      : askUserApproval,
    new ConsoleReporter(),
    new SessionCompactor(sessionStore),
    hooks,
  );
}

async function runTask(
  agent: AgentLoop,
  task: string,
  signal?: AbortSignal,
): Promise<string> {
  return agent.run(task, signal);
}

async function runSingleTask(agent: AgentLoop, task: string): Promise<void> {
  const controller = new AbortController();
  let cancellationRequested = false;
  const handleInterrupt = () => {
    if (cancellationRequested) {
      process.exit(130);
    }

    cancellationRequested = true;
    console.error(
      "\nCancelling task gracefully. Press Ctrl+C again to exit immediately.",
    );
    controller.abort();
  };
  process.on("SIGINT", handleInterrupt);

  try {
    const result = await runTask(agent, task, controller.signal);

    if (result === CANCELLED_TEXT) {
      process.exitCode = 130;
    }
  } finally {
    process.off("SIGINT", handleInterrupt);
  }
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
      const terminationDecision = prompt.handleTerminationAnswer(task);

      if (terminationDecision === "exit") {
        console.log("Bye.");
        return;
      }

      if (terminationDecision === "continue") {
        console.log("Continuing session.");
        continue;
      }

      if (terminationDecision === "pending") {
        console.log("Please type y to exit or n to continue.");
        continue;
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
        try {
          const nextRuntime = createRuntime(await sessionManager.create());
          await runtime.session.release();
          runtime = nextRuntime;
          console.log(`New session: ${runtime.session.id}`);
        } catch (error: unknown) {
          console.error(`Unable to create session: ${errorMessage(error)}`);
        }
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
        try {
          const nextSession = await sessionManager.resume(sessionId);

          if (nextSession.id !== runtime.session.id) {
            const nextRuntime = createRuntime(nextSession);
            await runtime.session.release();
            runtime = nextRuntime;
          }
          console.log(`Resumed session: ${runtime.session.id}`);
        } catch (error: unknown) {
          console.error(`Unable to resume session: ${errorMessage(error)}`);
        }
        continue;
      }

      const controller = prompt.beginTask();
      let result: string | undefined;

      try {
        result = await runTask(runtime.agent, trimmed, controller.signal);
      } catch (error: unknown) {
        console.error(`Task failed: ${errorMessage(error)}`);
      } finally {
        prompt.endTask(controller);
      }

      if (result === CANCELLED_TEXT) {
        prompt.markTaskCancelled();
      }
    }
  } finally {
    try {
      await runtime.session.release();
    } finally {
      prompt.close();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printWorktreeReminder(worktree: WorktreeInfo | undefined): void {
  if (!worktree) {
    return;
  }

  console.log(`Worktree retained: ${worktree.path}`);
  console.log(`Review branch before merging: ${worktree.branch}`);
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
  private rl: ReturnType<typeof createInterface>;
  private terminationPending = false;
  private activeTask?: AbortController;
  private inputSuspended = false;

  constructor() {
    this.rl = this.createReadline();
  }

  async question(prompt: string): Promise<string> {
    return this.rl.question(`${prompt}> `);
  }

  resumeInput(): void {
    if (this.inputSuspended) {
      this.rl = this.createReadline();
      this.inputSuspended = false;
      return;
    }

    this.rl.resume();
  }

  pauseInput(): void {
    if (this.inputSuspended) {
      return;
    }

    this.rl.close();
    this.inputSuspended = true;
  }

  beginTask(): AbortController {
    const controller = new AbortController();
    this.activeTask = controller;
    return controller;
  }

  endTask(controller: AbortController): void {
    if (this.activeTask === controller) {
      this.activeTask = undefined;
    }
    this.resumeInput();
  }

  markTaskCancelled(): void {
    if (this.terminationPending) {
      return;
    }

    this.terminationPending = true;
    this.rl.write(
      "\nTask cancelled. Type y to terminate the session or n to continue. Press Ctrl+C again to exit immediately.\n",
    );
  }

  handleTerminationAnswer(
    answer: string,
  ): "none" | "exit" | "continue" | "pending" {
    if (!this.terminationPending) {
      return "none";
    }

    const normalized = answer.trim().toLowerCase();

    if (["y", "yes"].includes(normalized)) {
      return "exit";
    }

    if (["n", "no"].includes(normalized)) {
      this.terminationPending = false;
      return "continue";
    }

    return "pending";
  }

  close(): void {
    this.rl.close();
  }

  private createReadline(): ReturnType<typeof createInterface> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.on("SIGINT", () => {
      if (this.activeTask && !this.activeTask.signal.aborted) {
        this.terminationPending = true;
        this.activeTask.abort();
        rl.write(
          "\nCancelling current task. Type y to terminate the session after cleanup, n to continue. Press Ctrl+C again to exit immediately.\n",
        );
        return;
      }

      if (this.terminationPending) {
        this.close();
        process.exit(130);
      }

      this.terminationPending = true;
      rl.write(
        "\nTerminate session? Type y to exit, n to continue. Press Ctrl+C again to exit immediately.\n",
      );
    });

    return rl;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
