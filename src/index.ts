#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import { AgentLoop } from "./agent/loop.js";
import { createSessionBackgroundTasks } from "./agent/backgroundTasks.js";
import type { AgentBudget } from "./agent/budget.js";
import { CANCELLED_TEXT } from "./agent/cancellation.js";
import { ContextBuilder } from "./agent/context.js";
import { SessionCompactor } from "./agent/compaction.js";
import type { AgentReporter } from "./agent/reporter.js";
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
import { AnthropicModel } from "./model/anthropic.js";
import { GeminiModel } from "./model/gemini.js";
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
import {
  defaultPolicy,
  type PermissionPolicy,
} from "./permissions/policy.js";
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
import { userStateRoot } from "./runtime/productPaths.js";
import { CheckpointManager } from "./runtime/checkpoints.js";
import { BackgroundCommandManager } from "./runtime/backgroundCommands.js";
import { SkillLoader } from "./skills/loader.js";
import { registerBashRuntime } from "./tools/bashRuntime.js";
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
  MachineReporter,
  type OutputFormat,
} from "./ui/machineReporter.js";
import { InteractivePrompt } from "./cli/interactivePrompt.js";
import {
  disposeInteractiveRuntime,
  runInteractiveSession,
  type InteractiveRuntime,
} from "./cli/interactiveSession.js";
import {
  parseInputFormat,
  parseOutputFormat,
  resolveTaskInput,
} from "./cli/io.js";
import {
  numericConfig,
  optionOrEnv,
  parseCli,
  parseNonNegativeInteger,
  parsePositiveInteger,
  resolveOptionalStringOption,
  resolveStringOption,
} from "./cli/program.js";
import { runMcpConfigCommand } from "./cli/mcpConfig.js";
import { runDoctorCommand } from "./cli/doctor.js";
import { runMigrationCommand } from "./cli/migrate.js";
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

let activeMcpManager: McpManager | undefined;
let activeTelemetrySink: TelemetrySink = noopTelemetrySink;

async function main(): Promise<void> {
  if (await runMigrationCommand()) {
    return;
  }
  if (await runDoctorCommand()) {
    return;
  }
  if (await runMcpConfigCommand()) {
    return;
  }
  const { program, options: opts } = parseCli();
  const outputFormat = parseOutputFormat(opts.outputFormat);
  const inputFormat = parseInputFormat(opts.inputFormat);
  const task = await resolveTaskInput(opts.task, inputFormat);
  if (outputFormat !== "text" && !task) {
    throw new Error("Machine-readable output requires a non-interactive task.");
  }
  const sourceWorkspaceRoot = path.resolve(opts.cwd);
  const userConfigPath =
    opts.config ??
    process.env.MONTANE_CONFIG ??
    process.env.HARNESS_CONFIG ??
    defaultUserConfigPath();
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
    "MONTANE_PROVIDER",
    userConfig.model?.provider,
    "OPENAI_PROVIDER",
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
    writeDiagnostic(`Worktree: ${worktree.path}`, outputFormat, opts.quiet);
    writeDiagnostic(`Branch: ${worktree.branch}`, outputFormat, opts.quiet);
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
          path.join(userStateRoot(homedir()), "telemetry"),
        );
  activeTelemetrySink = telemetry;
  const sandboxConfig = parseSandboxConfig({
    mode: optionOrEnv(
      program,
      "bashSandbox",
      opts.bashSandbox,
      "MONTANE_BASH_SANDBOX",
      "HARNESS_BASH_SANDBOX",
    ),
    image: optionOrEnv(
      program,
      "sandboxImage",
      opts.sandboxImage,
      "MONTANE_SANDBOX_IMAGE",
      "HARNESS_SANDBOX_IMAGE",
    ),
    pull: optionOrEnv(
      program,
      "sandboxPull",
      opts.sandboxPull,
      "MONTANE_SANDBOX_PULL",
      "HARNESS_SANDBOX_PULL",
    ),
    network: optionOrEnv(
      program,
      "sandboxNetwork",
      opts.sandboxNetwork,
      "MONTANE_SANDBOX_NETWORK",
      "HARNESS_SANDBOX_NETWORK",
    ),
    memory: optionOrEnv(
      program,
      "sandboxMemory",
      opts.sandboxMemory,
      "MONTANE_SANDBOX_MEMORY",
      "HARNESS_SANDBOX_MEMORY",
    ),
    cpus: optionOrEnv(
      program,
      "sandboxCpus",
      opts.sandboxCpus,
      "MONTANE_SANDBOX_CPUS",
      "HARNESS_SANDBOX_CPUS",
    ),
    pids: optionOrEnv(
      program,
      "sandboxPids",
      opts.sandboxPids,
      "MONTANE_SANDBOX_PIDS",
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
      "MONTANE_MODEL",
      userConfig.model?.name,
      "OPENAI_MODEL",
    ) ?? defaultModelName(provider);
  const sessionManager = new SessionManager(workspaceRoot, { model: modelName });
  const baseUrl = resolveProviderBaseUrl(
    program,
    provider,
    opts.baseUrl,
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
      "MONTANE_MAX_TURNS",
      numericConfig(userConfig.budget?.maxTurns),
      "HARNESS_MAX_TURNS",
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
        "MONTANE_MAX_WALL_TIME_MS",
        numericConfig(userConfig.budget?.maxWallTimeMs),
        "HARNESS_MAX_WALL_TIME_MS",
      ),
      "--max-wall-time-ms",
    ),
    maxInputTokens: parsePositiveInteger(
      resolveStringOption(
        program,
        "maxInputTokens",
        opts.maxInputTokens,
        "MONTANE_MAX_INPUT_TOKENS",
        numericConfig(userConfig.budget?.maxInputTokens),
        "HARNESS_MAX_INPUT_TOKENS",
      ),
      "--max-input-tokens",
    ),
    maxOutputTokens: parsePositiveInteger(
      resolveStringOption(
        program,
        "maxOutputTokens",
        opts.maxOutputTokens,
        "MONTANE_MAX_OUTPUT_TOKENS",
        numericConfig(userConfig.budget?.maxOutputTokens),
        "HARNESS_MAX_OUTPUT_TOKENS",
      ),
      "--max-output-tokens",
    ),
    maxToolCalls: parseNonNegativeInteger(
      resolveStringOption(
        program,
        "maxToolCalls",
        opts.maxToolCalls,
        "MONTANE_MAX_TOOL_CALLS",
        numericConfig(userConfig.budget?.maxToolCalls),
        "HARNESS_MAX_TOOL_CALLS",
      ),
      "--max-tool-calls",
    ),
    maxModelRetries: parseNonNegativeInteger(
      resolveStringOption(
        program,
        "maxModelRetries",
        opts.maxModelRetries,
        "MONTANE_MAX_MODEL_RETRIES",
        numericConfig(userConfig.budget?.maxModelRetries),
        "HARNESS_MAX_MODEL_RETRIES",
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
  writeDiagnostic(
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
    outputFormat,
    opts.quiet,
  );
  const initialSession = await sessionManager.start(opts.resume);
  const interactivePrompt = task ? undefined : new InteractivePrompt();
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
      outputFormat,
      quiet: opts.quiet,
      permissionMode: opts.permissionMode,
    });
    return { session, ...created };
  };
  const runtime = createRuntime(initialSession);

  if (task || !interactivePrompt) {
    if (!task) {
      throw new Error("Task is required when interactive input is unavailable.");
    }

    writeDiagnostic(`Session: ${runtime.session.id}`, outputFormat, opts.quiet);
    try {
      const result = await runSingleTask(runtime.agent, task);
      if (outputFormat === "text" && opts.quiet) {
        process.stdout.write(`${result}\n`);
      }
      if (runtime.reporter instanceof MachineReporter) {
        runtime.reporter.finish(
          runtime.session.id,
          result === CANCELLED_TEXT ? "cancelled" : "completed",
          result,
          await summarizeMachineUsage(runtime.sessionStore),
        );
      }
    } catch (error: unknown) {
      if (runtime.reporter instanceof MachineReporter) {
        runtime.reporter.finish(runtime.session.id, "failed", errorMessage(error));
      }
      throw error;
    } finally {
      await disposeInteractiveRuntime(runtime);
    }
    printWorktreeReminder(worktree, outputFormat, opts.quiet);
    return;
  }

  await runInteractiveSession(
    runtime,
    interactivePrompt,
    sessionManager,
    createRuntime,
  );
  printWorktreeReminder(worktree, outputFormat, opts.quiet);
}

interface RuntimeReporter extends AgentReporter {
  dispose(): void;
  toggleToolDetails?(): void;
}

interface SessionRuntime extends InteractiveRuntime {
  session: ManagedSession;
  agent: AgentLoop;
  telemetry: SessionTelemetryObserver;
  reporter: RuntimeReporter;
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
  outputFormat: OutputFormat;
  quiet: boolean;
  permissionMode: string;
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
): {
  agent: AgentLoop;
  telemetry: SessionTelemetryObserver;
  reporter: RuntimeReporter;
  sessionStore: SessionStore;
  compactor: SessionCompactor;
  checkpoints: CheckpointManager;
  backgroundTasks: BackgroundCommandManager;
  tools: ToolRegistry;
  modelName: string;
  permissionMode: string;
} {
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
  const backgroundTasks = createSessionBackgroundTasks(
    options.shellExecutor,
    sessionStore,
  );
  const hooks = new HookManager();
  const skillLoader = new SkillLoader(options.workspace);
  const checkpoints = new CheckpointManager(
    options.workspace,
    options.session.directoryPath,
  );
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
  tools.register(checkpoints.wrap(new WriteTool(options.workspace)));
  tools.register(checkpoints.wrap(new EditTool(options.workspace)));
  registerBashRuntime(
    tools, options.workspace, options.shellExecutor, backgroundTasks,
  );
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
  applyPermissionMode(permissionPolicy, options.permissionMode);
  for (const tool of options.mcpTools) {
    if (tool.effect === "readonly") {
      permissionPolicy.allowedTools.add(tool.name);
    } else if (["plan", "deny"].includes(options.permissionMode)) {
      permissionPolicy.deniedTools.add(tool.name);
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

  const reporter: RuntimeReporter =
    options.outputFormat === "text"
      ? new ConsoleReporter(
          (text) => {
            if (!options.quiet) {
              if (options.interactivePrompt) {
                options.interactivePrompt.writeAboveInput(text);
              } else {
                process.stdout.write(text);
              }
            }
          },
          options.interactivePrompt !== undefined,
        )
      : new MachineReporter(options.outputFormat);
  options.interactivePrompt?.setToggleDetailsHandler(() =>
    reporter.toggleToolDetails?.(),
  );

  const compactor = new SessionCompactor(
    sessionStore,
    eventThreshold,
    options.compaction?.fallbackTokenThreshold,
  );
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
      : async () => "reject",
    reporter,
    compactor,
    hooks,
    (status) => options.session.updateStatus(status).then(() => undefined),
    options.budget,
    options.compaction?.contextWindowRatio,
  );
  return {
    agent,
    telemetry,
    reporter,
    sessionStore,
    compactor,
    checkpoints,
    backgroundTasks,
    tools,
    modelName: options.modelName,
    permissionMode: options.permissionMode,
  };
}

async function runSingleTask(agent: AgentLoop, task: string): Promise<string> {
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
    const result = await agent.run(task, controller.signal);

    if (result === CANCELLED_TEXT) {
      process.exitCode = 130;
    }
    return result;
  } finally {
    process.off("SIGINT", handleInterrupt);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function summarizeMachineUsage(
  session: SessionStore,
): Promise<{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}> {
  const events = await session.load();
  return events.reduce(
    (total, event) => {
      if (event.type !== "model_response_received" || !event.usage) return total;
      total.inputTokens += event.usage.inputTokens;
      total.outputTokens += event.usage.outputTokens;
      total.cacheReadTokens += event.usage.cacheReadTokens ?? 0;
      total.estimatedCostUsd += event.usage.estimatedCostUsd ?? 0;
      return total;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      estimatedCostUsd: 0,
    },
  );
}

function printWorktreeReminder(
  worktree: WorktreeInfo | undefined,
  outputFormat: OutputFormat,
  quiet: boolean,
): void {
  if (!worktree) {
    return;
  }

  writeDiagnostic(`Worktree retained: ${worktree.path}`, outputFormat, quiet);
  writeDiagnostic(
    `Review branch before merging: ${worktree.branch}`,
    outputFormat,
    quiet,
  );
}

function writeDiagnostic(
  message: string,
  outputFormat: OutputFormat,
  quiet: boolean,
): void {
  if (quiet) {
    return;
  }
  const stream = outputFormat === "text" ? process.stdout : process.stderr;
  stream.write(`${message}\n`);
}

function applyPermissionMode(
  policy: PermissionPolicy,
  mode: string,
): void {
  if (!["default", "plan", "accept-edits", "deny"].includes(mode)) {
    throw new Error(
      "--permission-mode must be default, plan, accept-edits, or deny.",
    );
  }
  if (mode === "accept-edits") {
    policy.allowedTools.add("Edit");
    policy.allowedTools.add("Write");
    return;
  }
  if (mode === "plan" || mode === "deny") {
    for (const name of [
      "Write",
      "Edit",
      "Bash",
      "MemoryWrite",
      "MemoryDelete",
    ]) {
      policy.deniedTools.add(name);
      policy.allowedTools.delete(name);
    }
  }
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

  if (provider === "anthropic") {
    return new AnthropicModel({
      apiKey: process.env.ANTHROPIC_API_KEY as string,
      model,
      baseUrl,
      pricing,
      capabilities,
    });
  }

  if (provider === "gemini") {
    return new GeminiModel({
      apiKey: process.env.GEMINI_API_KEY as string,
      model,
      baseUrl,
      pricing,
      capabilities,
    });
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
  if (!["openai", "anthropic", "gemini", "mock"].includes(provider)) {
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
        "  3. Otherwise, Montane Code loads .env from the workspace root.",
        "",
        "For loop-only development without an API call, run:",
        "  npm start -- --provider mock --task \"Inspect README.md\"",
      ].join("\n"),
    );
  }
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for Anthropic models.");
  }
  if (provider === "gemini" && !process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required for Gemini models.");
  }
}

function defaultModelName(provider: string): string {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  if (provider === "gemini") return "gemini-2.5-pro";
  return "gpt-4.1";
}

function resolveProviderBaseUrl(
  program: ReturnType<typeof parseCli>["program"],
  provider: string,
  cliValue: string | undefined,
  configValue: string | undefined,
): string | undefined {
  if (program.getOptionValueSource("baseUrl") === "cli") return cliValue;
  const environmentName =
    provider === "anthropic"
      ? "ANTHROPIC_BASE_URL"
      : provider === "gemini"
        ? "GEMINI_BASE_URL"
        : "OPENAI_BASE_URL";
  return process.env[environmentName] ?? configValue;
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
