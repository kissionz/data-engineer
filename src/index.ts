#!/usr/bin/env node

import { Command } from "commander";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { AgentLoop } from "./agent/loop.js";
import {
  DEFAULT_AGENT_BUDGET,
  type AgentBudget,
} from "./agent/budget.js";
import { CANCELLED_TEXT } from "./agent/cancellation.js";
import { ContextBuilder } from "./agent/context.js";
import { SessionCompactor } from "./agent/compaction.js";
import {
  SessionManager,
  type ManagedSession,
} from "./agent/sessionManager.js";
import { HookManager } from "./hooks/manager.js";
import { protectSensitiveWrites } from "./hooks/defaults.js";
import type {
  ModelCapabilities,
  ModelClient,
  ModelPricing,
} from "./model/base.js";
import { SessionStore } from "./agent/session.js";
import { MockModel } from "./model/mock.js";
import {
  OpenAIModel,
  parseApiStyle,
  type ApiStyle,
} from "./model/openai.js";
import { memoryPathsForWorkspace } from "./memory/paths.js";
import { MemoryService } from "./memory/service.js";
import { McpManager } from "./mcp/manager.js";
import type { McpToolAdapter } from "./mcp/toolAdapter.js";
import {
  askUserApproval,
  restoreInputAfterApproval,
} from "./permissions/approval.js";
import { defaultPolicy } from "./permissions/policy.js";
import { PermissionGate } from "./permissions/gate.js";
import {
  defaultFolderGrantPath,
  FolderGrantManager,
} from "./permissions/folderGrants.js";
import {
  loadStartupEnv,
  selectEnvFile,
} from "./runtime/env.js";
import { DockerAvailabilityChecker } from "./runtime/dockerAvailability.js";
import { DockerShellExecutor } from "./runtime/dockerShellExecutor.js";
import { LocalCommandExecutor } from "./runtime/localExecutor.js";
import { LocalShellExecutor, type NetworkPolicy } from "./runtime/localShellExecutor.js";
import {
  discoverRuntimeCapabilities,
  type RuntimeCapabilities,
} from "./runtime/capabilities.js";
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
import { ListDirectoryTool } from "./tools/listDirectory.js";
import { ReadTool } from "./tools/read.js";
import { SkillListTool, SkillLoadTool } from "./tools/skill.js";
import { EphemeralTaskTool, TaskTool } from "./tools/task.js";
import { ToolRegistry } from "./tools/registry.js";
import { TodoReadTool, TodoStore, TodoWriteTool } from "./tools/todo.js";
import {
  MemoryDeleteTool,
  MemorySearchTool,
  MemoryWriteTool,
} from "./tools/memory.js";
import { WriteTool } from "./tools/write.js";
import { HttpFetchTool } from "./tools/httpFetch.js";
import { ConsoleReporter } from "./ui/consoleReporter.js";
import {
  defaultUserConfigPath,
  loadUserConfig,
  type HttpFetchConfig,
  type UserConfig,
} from "./config/userConfig.js";
import {
  applyProjectRestrictions,
  loadProjectConfig,
} from "./config/projectConfig.js";
import {
  createTelemetrySink,
  flushSessionTelemetryObservers,
  noopTelemetrySink,
  SessionTelemetryObserver,
  type TelemetrySink,
} from "./telemetry/index.js";

interface CliOptions {
  task?: string;
  config?: string;
  envFile?: string;
  cwd: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  apiStyle?: string;
  maxTurns: string;
  maxWallTimeMs: string;
  maxInputTokens: string;
  maxOutputTokens: string;
  maxToolCalls: string;
  maxModelRetries: string;
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

let activeMcpManager: McpManager | undefined;
let activeTelemetrySink: TelemetrySink = noopTelemetrySink;

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("harness")
    .description("TypeScript local coding agent harness")
    .option("-t, --task <task>", "Task to run")
    .option("--config <path>", "Trusted user config file")
    .option("--env-file <path>", "Explicit environment file to load")
    .option("--cwd <cwd>", "Workspace directory", process.cwd())
    .option("--provider <provider>", "Model provider: openai or mock", "openai")
    .option("--model <model>", "Model name")
    .option("--base-url <baseUrl>", "OpenAI-compatible API base URL")
    .option(
      "--api-style <style>",
      "API style: responses (OpenAI native) or chat_completions (compatible)",
    )
    .option("--max-turns <turns>", "Maximum agent turns per user message", "50")
    .option(
      "--max-wall-time-ms <milliseconds>",
      "Maximum wall time per user message",
      String(DEFAULT_AGENT_BUDGET.maxWallTimeMs),
    )
    .option(
      "--max-input-tokens <tokens>",
      "Maximum provider input tokens per user message",
      String(DEFAULT_AGENT_BUDGET.maxInputTokens),
    )
    .option(
      "--max-output-tokens <tokens>",
      "Maximum provider output tokens per user message",
      String(DEFAULT_AGENT_BUDGET.maxOutputTokens),
    )
    .option(
      "--max-tool-calls <calls>",
      "Maximum tool calls per user message",
      String(DEFAULT_AGENT_BUDGET.maxToolCalls),
    )
    .option(
      "--max-model-retries <retries>",
      "Maximum model retries per user message",
      String(DEFAULT_AGENT_BUDGET.maxModelRetries),
    )
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
  const userConfigPath =
    opts.config ?? process.env.HARNESS_CONFIG ?? defaultUserConfigPath();
  const userConfig = await loadUserConfig(userConfigPath);
  const envFile = selectEnvFile({
    workspaceRoot: sourceWorkspaceRoot,
    userConfigPath,
    cliEnvFile: opts.envFile,
    userEnvFile: userConfig.envFile,
  });
  await loadStartupEnv(envFile, import.meta.url);
  const provider = resolveStringOption(
    program,
    "provider",
    opts.provider,
    "OPENAI_PROVIDER",
    userConfig.model?.provider,
  );
  assertModelConfiguration(provider);

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
  const projectConfig = await loadProjectConfig(workspaceRoot);
  const runtimeCapabilities = await discoverRuntimeCapabilities(
    executor,
    workspaceRoot,
  );
  const memoryEnabled =
    userConfig.memory?.enabled !== false &&
    projectConfig.memory?.enabled !== false;
  const memory = memoryEnabled
    ? new MemoryService(memoryPathsForWorkspace(workspaceRoot))
    : undefined;
  const folderGrants = await FolderGrantManager.load(
    defaultFolderGrantPath(),
  );
  const telemetry =
    userConfig.telemetry?.enabled === false
      ? noopTelemetrySink
      : createTelemetrySink(
          path.join(homedir(), ".harness", "telemetry"),
        );
  activeTelemetrySink = telemetry;
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
  const mcpManager = new McpManager();
  activeMcpManager = mcpManager;
  await mcpManager.start(userConfig.mcpServers);
  const modelName =
    resolveOptionalStringOption(
      program,
      "model",
      opts.model,
      "OPENAI_MODEL",
      userConfig.model?.name,
    ) ?? "gpt-4.1";
  const sessionManager = new SessionManager(workspaceRoot, { model: modelName });
  const baseUrl = resolveOptionalStringOption(
    program,
    "baseUrl",
    opts.baseUrl,
    "OPENAI_BASE_URL",
    userConfig.model?.baseUrl,
  );
  const apiStyleRaw = resolveOptionalStringOption(
    program,
    "apiStyle",
    opts.apiStyle,
    "OPENAI_API_STYLE",
    undefined,
  );
  const apiStyle = parseApiStyle(apiStyleRaw);
  const maxTurns = parsePositiveInteger(
    resolveStringOption(
      program,
      "maxTurns",
      opts.maxTurns,
      "HARNESS_MAX_TURNS",
      numericConfig(userConfig.budget?.maxTurns),
    ),
    "--max-turns",
  );
  const baseBudget: AgentBudget = {
    maxTurns,
    maxWallTimeMs: parsePositiveInteger(
      resolveStringOption(
        program,
        "maxWallTimeMs",
        opts.maxWallTimeMs,
        "HARNESS_MAX_WALL_TIME_MS",
        numericConfig(userConfig.budget?.maxWallTimeMs),
      ),
      "--max-wall-time-ms",
    ),
    maxInputTokens: parsePositiveInteger(
      resolveStringOption(
        program,
        "maxInputTokens",
        opts.maxInputTokens,
        "HARNESS_MAX_INPUT_TOKENS",
        numericConfig(userConfig.budget?.maxInputTokens),
      ),
      "--max-input-tokens",
    ),
    maxOutputTokens: parsePositiveInteger(
      resolveStringOption(
        program,
        "maxOutputTokens",
        opts.maxOutputTokens,
        "HARNESS_MAX_OUTPUT_TOKENS",
        numericConfig(userConfig.budget?.maxOutputTokens),
      ),
      "--max-output-tokens",
    ),
    maxToolCalls: parseNonNegativeInteger(
      resolveStringOption(
        program,
        "maxToolCalls",
        opts.maxToolCalls,
        "HARNESS_MAX_TOOL_CALLS",
        numericConfig(userConfig.budget?.maxToolCalls),
      ),
      "--max-tool-calls",
    ),
    maxModelRetries: parseNonNegativeInteger(
      resolveStringOption(
        program,
        "maxModelRetries",
        opts.maxModelRetries,
        "HARNESS_MAX_MODEL_RETRIES",
        numericConfig(userConfig.budget?.maxModelRetries),
      ),
      "--max-model-retries",
    ),
    ...(userConfig.budget?.maxEstimatedCostUsd !== undefined
      ? {
          maxEstimatedCostUsd:
            userConfig.budget.maxEstimatedCostUsd,
        }
      : {}),
  };
  const { budget } = applyProjectRestrictions(
    {
      budget: baseBudget,
      memoryEnabled,
    },
    projectConfig,
    { pricing: userConfig.model?.pricing },
  );
  console.log(
    [
      `Runtime: provider=${provider}`,
      `model=${modelName}`,
      `endpoint=${baseUrl ? "custom" : "default"}`,
      `memory=${memory ? "on" : "off"}`,
      `telemetry=${telemetry === noopTelemetrySink ? "off" : "on"}`,
      `mcpTools=${mcpManager.tools.length}`,
      `httpFetch=${userConfig.httpFetch?.enabled ? "on" : "off"}`,
      `git=${runtimeCapabilities.gitRepository ? "repository" : runtimeCapabilities.git ? "available" : "unavailable"}`,
      `rg=${runtimeCapabilities.ripgrep ? "available" : "unavailable"}`,
      `search=${runtimeCapabilities.ripgrep ? "ripgrep" : "native"}`,
      `projectConfig=${projectConfig.budget || projectConfig.memory ? "restricted" : "none"}`,
      `budget(turns=${budget.maxTurns}, tools=${budget.maxToolCalls}, wallMs=${budget.maxWallTimeMs})`,
    ].join(" "),
  );
  const initialSession = await sessionManager.start(opts.resume);
  const interactivePrompt = opts.task ? undefined : new InteractivePrompt();
  const createRuntime = (session: ManagedSession): SessionRuntime => {
    const created = createAgent({
      session,
      workspaceRoot,
      workspace,
      executor,
      shellExecutor: shellExecutorFactory(session),
      provider,
      modelName,
      baseUrl,
      apiStyle,
      modelPricing: userConfig.model?.pricing,
      modelCapabilities: userConfig.model?.capabilities,
      maxTurns,
      budget,
      memory,
      mcpTools: mcpManager.tools,
      telemetry,
      interactivePrompt,
      runtimeCapabilities,
      httpFetch: userConfig.httpFetch,
      compaction: userConfig.compaction,
      folderGrants,
    });
    return { session, ...created };
  };
  const runtime = createRuntime(initialSession);

  if (opts.task || !interactivePrompt) {
    if (!opts.task) {
      throw new Error("Task is required when interactive input is unavailable.");
    }

    console.log(`Session: ${runtime.session.id}`);
    try {
      await runSingleTask(runtime.agent, opts.task);
    } finally {
      try {
        await runtime.telemetry.dispose();
      } finally {
        await runtime.session.release();
      }
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

function resolveStringOption(
  program: Command,
  optionName: string,
  optionValue: string,
  environmentName: string,
  configValue?: string,
): string {
  return (
    program.getOptionValueSource(optionName) === "cli"
      ? optionValue
      : process.env[environmentName] ?? configValue ?? optionValue
  );
}

function resolveOptionalStringOption(
  program: Command,
  optionName: string,
  optionValue: string | undefined,
  environmentName: string,
  configValue?: string,
): string | undefined {
  return program.getOptionValueSource(optionName) === "cli"
    ? optionValue
    : process.env[environmentName] ?? configValue ?? optionValue;
}

function numericConfig(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

interface SessionRuntime {
  session: ManagedSession;
  agent: AgentLoop;
  telemetry: SessionTelemetryObserver;
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
  apiStyle?: ApiStyle;
  modelPricing?: ModelPricing;
  modelCapabilities?: Partial<ModelCapabilities>;
  maxTurns: number;
  budget: AgentBudget;
  memory?: MemoryService;
  mcpTools: readonly McpToolAdapter[];
  telemetry: TelemetrySink;
  interactivePrompt?: InteractivePrompt;
  runtimeCapabilities: RuntimeCapabilities;
  httpFetch?: HttpFetchConfig;
  compaction?: UserConfig["compaction"];
  folderGrants: FolderGrantManager;
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
    const networkPolicy: NetworkPolicy = config.network === "none" ? "restricted" : "unrestricted";
    const local = new LocalShellExecutor(executor, networkPolicy);
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

function createAgent(
  options: CreateAgentOptions,
): { agent: AgentLoop; telemetry: SessionTelemetryObserver } {
  const tools = new ToolRegistry();
  const model = createModel(
    options.provider,
    options.modelName,
    options.baseUrl,
    options.apiStyle,
    options.modelPricing,
    options.modelCapabilities,
  );
  const todoStore = new TodoStore(options.session.todoPath);
  const telemetry = new SessionTelemetryObserver(options.telemetry, {
    provider: options.provider,
    model: options.modelName,
  });
  const sessionStore = new SessionStore(
    options.session.sessionPath,
    options.session.id,
    async (event) => {
      void telemetry.observe(event);
      await options.session.updateLastSequence(event.sequence);
    },
  );
  const hooks = new HookManager();
  const skillLoader = new SkillLoader(options.workspace);
  hooks.register("BeforeToolUse", protectSensitiveWrites);

  tools.register(new ReadTool(options.workspace));
  tools.register(new ListDirectoryTool(options.workspace));
  if (options.httpFetch?.enabled) {
    tools.register(
      new HttpFetchTool({
        allowedHosts: options.httpFetch.allowedHosts,
        allowedPorts: options.httpFetch.allowedPorts,
        allowHttpLocalhost:
          options.httpFetch.allowHttpLocalhost,
        maxRedirects: options.httpFetch.maxRedirects,
        maxResponseBytes: options.httpFetch.maxResponseBytes,
        timeoutMs: options.httpFetch.timeoutMs,
      }),
    );
  }
  tools.register(
    new GrepTool(
      options.workspace,
      options.executor,
      12_000,
      options.runtimeCapabilities.ripgrep,
    ),
  );
  tools.register(
    new GlobTool(
      options.workspace,
      options.executor,
      300,
      options.runtimeCapabilities.ripgrep,
    ),
  );
  tools.register(new WriteTool(options.workspace));
  tools.register(new EditTool(options.workspace));
  if (options.shellExecutor) {
    tools.register(new BashTool(options.workspace, options.shellExecutor));
  }
  if (
    options.runtimeCapabilities.git &&
    options.runtimeCapabilities.gitRepository
  ) {
    tools.register(new GitStatusTool(options.workspace, options.executor));
    tools.register(new GitDiffTool(options.workspace, options.executor));
  }
  tools.register(new TodoReadTool(todoStore));
  tools.register(new TodoWriteTool(todoStore));
  tools.register(new SkillListTool(skillLoader));
  tools.register(new SkillLoadTool(skillLoader));
  if (options.memory) {
    tools.register(new MemorySearchTool(options.memory));
    const memoryAuthorization = (context?: { userApproved?: boolean }) => ({
      explicitUserRequest: context?.userApproved === true,
      source: {
        type: "user" as const,
        sessionId: options.session.id,
      },
    });
    tools.register(new MemoryWriteTool(options.memory, memoryAuthorization));
    tools.register(new MemoryDeleteTool(options.memory, memoryAuthorization));
  }
  for (const tool of options.mcpTools) {
    tools.register(tool);
  }
  const taskTool = new TaskTool(
    model,
    options.workspace,
    options.executor,
    options.session.id,
    undefined,
    {
      sink: options.telemetry,
      provider: options.provider,
      model: options.modelName,
    },
    options.runtimeCapabilities,
  );
  tools.register(taskTool);
  tools.register(new EphemeralTaskTool(taskTool));

  const permissionPolicy = defaultPolicy();
  for (const tool of options.mcpTools) {
    if (tool.effect === "readonly") {
      permissionPolicy.allowedTools.add(tool.name);
    }
  }

  const maxRecentEvents =
    options.compaction?.maxRecentEvents === 0
      ? null
      : options.compaction?.maxRecentEvents;
  const eventThreshold =
    options.compaction?.eventThreshold === 0
      ? null
      : options.compaction?.eventThreshold;

  const agent = new AgentLoop(
    model,
    tools,
    new PermissionGate(
      permissionPolicy,
      options.workspaceRoot,
      options.folderGrants,
    ),
    new ContextBuilder(
      options.workspaceRoot,
      maxRecentEvents,
      undefined,
      options.memory,
      skillLoader,
      options.folderGrants,
    ),
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
    new SessionCompactor(
      sessionStore,
      eventThreshold,
      options.compaction?.fallbackTokenThreshold,
    ),
    hooks,
    (status) => options.session.updateStatus(status).then(() => undefined),
    options.budget,
    options.compaction?.contextWindowRatio,
  );
  return { agent, telemetry };
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
  console.log(
    "Commands: /new, /resume <id>, /session, /sessions, /inspect [id], /exit",
  );

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
          await runtime.telemetry.dispose();
          await runtime.session.release();
          runtime = nextRuntime;
          console.log(`New session: ${runtime.session.id}`);
        } catch (error: unknown) {
          console.error(`Unable to create session: ${errorMessage(error)}`);
        }
        continue;
      }

      if (trimmed === "/session") {
        const metadata = await runtime.session.readMetadata();
        console.log(
          `Session: ${metadata.id}\nStatus: ${metadata.status}\nModel: ${metadata.model}`,
        );
        continue;
      }

      if (trimmed === "/sessions") {
        const sessions = await sessionManager.list();
        const summaries = await Promise.all(
          sessions.map(async (id) => {
            const metadata = await sessionManager.inspect(id);
            return `${id}\t${metadata.status}\t${metadata.model}`;
          }),
        );
        console.log(summaries.length > 0 ? summaries.join("\n") : "[No sessions]");
        continue;
      }

      if (trimmed === "/inspect" || trimmed.startsWith("/inspect ")) {
        const requestedId = trimmed.slice("/inspect".length).trim();

        try {
          const metadata =
            !requestedId || requestedId === runtime.session.id
              ? await runtime.session.readMetadata()
              : await sessionManager.inspect(requestedId);
          console.log(JSON.stringify(metadata, null, 2));
        } catch (error: unknown) {
          console.error(`Unable to inspect session: ${errorMessage(error)}`);
        }
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
            await runtime.telemetry.dispose();
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
      await runtime.telemetry.dispose();
    } finally {
      try {
        await runtime.session.release();
      } finally {
        prompt.close();
      }
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
  apiStyle?: ApiStyle,
  pricing?: ModelPricing,
  capabilities?: Partial<ModelCapabilities>,
): ModelClient {
  assertModelConfiguration(provider);

  if (provider === "mock") {
    return new MockModel();
  }

  return new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY as string,
    model,
    baseUrl,
    apiStyle,
    pricing,
    capabilities,
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
        "  1. Set OPENAI_API_KEY in the shell, or add it to a trusted env file.",
        "  2. Select that file with --env-file or user config envFile.",
        "  3. Otherwise, Harness loads .env from the workspace root.",
        "",
        "For loop-only development without an API call, run:",
        "  npm start -- --provider mock --task \"Inspect README.md\"",
      ].join("\n"),
    );
  }
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error(`${optionName} must be a non-negative integer.`);
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

void main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await activeMcpManager?.closeAll();
    await flushSessionTelemetryObservers();
    await activeTelemetrySink.close();
  });
