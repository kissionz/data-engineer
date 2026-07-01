import { randomBytes } from "node:crypto";
import path from "node:path";
import { CANCELLED_TEXT } from "../agent/cancellation.js";
import { AgentLoop } from "../agent/loop.js";
import { ContextBuilder } from "../agent/context.js";
import { SessionStore } from "../agent/session.js";
import type { ModelClient } from "../model/base.js";
import type { PermissionPolicy } from "../permissions/policy.js";
import { PermissionGate } from "../permissions/gate.js";
import type { CommandExecutor } from "../runtime/commandExecutor.js";
import type { RuntimeCapabilities } from "../runtime/capabilities.js";
import type { Workspace } from "../runtime/workspace.js";
import { SkillLoader } from "../skills/loader.js";
import {
  parseEphemeralSubagentSpec,
  SubagentSpecLoader,
} from "../subagents/loader.js";
import {
  EPHEMERAL_SUBAGENT_INPUT_SCHEMA,
  wrappedSubagentPrompt,
  type ReadonlySubagentToolName,
  type SubagentSpec,
} from "../subagents/spec.js";
import {
  SessionTelemetryObserver,
  type TelemetrySink,
} from "../telemetry/index.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";
import { GitDiffTool, GitStatusTool } from "./git.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { ReadTool } from "./read.js";
import { ToolRegistry } from "./registry.js";
import { SkillListTool, SkillLoadTool } from "./skill.js";

export class TaskTool implements Tool {
  name = "Task";
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  private readonly specs: ReadonlyMap<string, SubagentSpec>;
  private readonly ephemeralRuns = new Map<string, number>();

  constructor(
    private readonly model: ModelClient,
    private readonly workspace: Workspace,
    private readonly executor: CommandExecutor,
    private readonly parentSessionId: string,
    private readonly maxResultChars = 20_000,
    private readonly telemetry?: {
      sink: TelemetrySink;
      provider: string;
      model: string;
    },
    private readonly runtimeCapabilities: RuntimeCapabilities = {
      git: true,
      ripgrep: true,
      gitRepository: true,
    },
  ) {
    const specs = new SubagentSpecLoader(workspace).loadAll();
    this.specs = new Map(specs.map((spec) => [spec.name, spec]));
    // Project-authored descriptions are intentionally not placed in the tool
    // schema, where they could become prompt injection against the parent.
    this.description =
      `Run a bounded configured read-only subagent. Available role names: ` +
      specs.map((spec) => spec.name).join(", ");
    this.inputSchema = {
      type: "object",
      properties: {
        subagent: {
          type: "string",
          enum: specs.map((spec) => spec.name),
        },
        task: { type: "string", minLength: 1, maxLength: 4_000 },
      },
      required: ["subagent", "task"],
      additionalProperties: false,
    };
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const configuredSpec =
      typeof args.subagent === "string"
        ? this.specs.get(args.subagent)
        : undefined;
    if (
      typeof args.task !== "string" ||
      !args.task.trim() ||
      !configuredSpec
    ) {
      return {
        ok: false,
        content: "subagent and a non-empty task are required.",
        data: { reason: "invalid_subagent_task" },
      };
    }
    return this.runSpec(
      configuredSpec,
      args.task.trim(),
      context,
      false,
    );
  }

  async executeEphemeral(
    value: unknown,
    task: string,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (context?.explicitSubagentRequest !== true) {
      return {
        ok: false,
        content:
          "Creating an ephemeral subagent requires an explicit request from the current user.",
        data: { reason: "explicit_subagent_request_required" },
      };
    }
    let spec: SubagentSpec;
    try {
      spec = parseEphemeralSubagentSpec(value);
    } catch (error: unknown) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        data: { reason: "invalid_ephemeral_subagent" },
      };
    }
    if (this.specs.has(spec.name)) {
      return {
        ok: false,
        content: `Ephemeral subagent name conflicts with configured role: ${spec.name}`,
        data: { reason: "subagent_name_conflict" },
      };
    }
    if (!this.claimEphemeralRun(context)) {
      return {
        ok: false,
        content: "At most 8 ephemeral subagents may run for one user task.",
        data: { reason: "ephemeral_subagent_limit_reached" },
      };
    }
    return this.runSpec(spec, task, context, true);
  }

  private async runSpec(
    spec: SubagentSpec,
    task: string,
    context: ToolExecutionContext | undefined,
    ephemeral: boolean,
  ): Promise<ToolExecutionResult> {

    const skills = new SkillLoader(this.workspace);
    const tools = createReviewerTools(
      this.workspace,
      this.executor,
      this.runtimeCapabilities,
      skills,
      spec.tools,
    );
    const childSessionId = createChildSessionId(
      this.parentSessionId,
      spec.name,
    );
    const childSessionPath = path.join(
      this.workspace.root,
      ".harness",
      "sessions",
      `${childSessionId}.jsonl`,
    );
    const telemetry = this.telemetry
      ? new SessionTelemetryObserver(this.telemetry.sink, {
          provider: this.telemetry.provider,
          model: this.telemetry.model,
          trigger: "subagent",
        })
      : undefined;
    let result: string;
    try {
      result = await new AgentLoop(
        this.model,
        tools,
        new PermissionGate(readonlyPolicy(spec.tools)),
        new ContextBuilder(
          this.workspace.root,
          30,
          wrappedSubagentPrompt(spec),
          undefined,
          skills,
        ),
        new SessionStore(
          childSessionPath,
          childSessionId,
          telemetry
            ? async (event) => {
                await telemetry.observe(event);
              }
            : undefined,
        ),
        spec.maxTurns,
        async () => "reject",
      ).run(task, context?.signal, context?.budget);
    } finally {
      await telemetry?.dispose();
    }
    const resultLimit = Math.min(
      this.maxResultChars,
      spec.maxResultChars,
    );
    const truncated = result.length > resultLimit;

    if (result === CANCELLED_TEXT) {
      return {
        ok: false,
        content: CANCELLED_TEXT,
        data: {
          code: "cancelled",
          retryable: false,
          subagent: spec.name,
          childSessionId,
          ephemeral,
          reclaimed: ephemeral,
        },
      };
    }

    return {
      ok: true,
      content: truncated
        ? `${result.slice(0, resultLimit)}\n[Subagent result truncated]`
        : result,
      data: {
        subagent: spec.name,
        childSessionId,
        truncated,
        ephemeral,
        reclaimed: ephemeral,
      },
    };
  }

  private claimEphemeralRun(context: ToolExecutionContext | undefined): boolean {
    const key = context?.taskRunId ?? `approved:${context?.toolCallId ?? "unknown"}`;
    const count = this.ephemeralRuns.get(key) ?? 0;
    if (count >= 8) {
      return false;
    }
    this.ephemeralRuns.set(key, count + 1);
    while (this.ephemeralRuns.size > 32) {
      const oldest = this.ephemeralRuns.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.ephemeralRuns.delete(oldest);
    }
    return true;
  }
}

export class EphemeralTaskTool implements Tool {
  readonly name = "EphemeralTask";
  readonly description =
    'Create one temporary read-only subagent for the current subtask, only when the current user message starts with "/subagent <subtask>". The role is reclaimed immediately after the result.';
  readonly effect = "readonly" as const;
  readonly inputSchema = {
    type: "object",
    properties: {
      role: EPHEMERAL_SUBAGENT_INPUT_SCHEMA,
      task: { type: "string", minLength: 1, maxLength: 4_000 },
    },
    required: ["role", "task"],
    additionalProperties: false,
  };

  constructor(private readonly taskTool: TaskTool) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (typeof args.task !== "string" || !args.task.trim()) {
      return {
        ok: false,
        content: "role and a non-empty task are required.",
        data: { reason: "invalid_ephemeral_subagent" },
      };
    }
    return this.taskTool.executeEphemeral(
      args.role,
      args.task.trim(),
      context,
    );
  }
}

function createReviewerTools(
  workspace: Workspace,
  executor: CommandExecutor,
  capabilities: RuntimeCapabilities,
  skills = new SkillLoader(workspace),
  requestedTools: ReadonlyArray<ReadonlySubagentToolName>,
): ToolRegistry {
  const tools = new ToolRegistry();
  const requested = new Set(requestedTools);
  if (requested.has("Read")) {
    tools.register(new ReadTool(workspace));
  }
  if (requested.has("Grep")) {
    tools.register(
      new GrepTool(workspace, executor, 12_000, capabilities.ripgrep),
    );
  }
  if (requested.has("Glob")) {
    tools.register(
      new GlobTool(workspace, executor, 300, capabilities.ripgrep),
    );
  }
  if (capabilities.git && capabilities.gitRepository) {
    if (requested.has("GitStatus")) {
      tools.register(new GitStatusTool(workspace, executor));
    }
    if (requested.has("GitDiff")) {
      tools.register(new GitDiffTool(workspace, executor));
    }
  }
  if (requested.has("SkillList")) {
    tools.register(new SkillListTool(skills));
  }
  if (requested.has("SkillLoad")) {
    tools.register(new SkillLoadTool(skills));
  }
  return tools;
}

function readonlyPolicy(
  tools: ReadonlyArray<ReadonlySubagentToolName>,
): PermissionPolicy {
  return {
    allowedTools: new Set(tools),
    deniedTools: new Set([
      "Write",
      "Edit",
      "Bash",
      "Task",
      "EphemeralTask",
      "TodoRead",
      "TodoWrite",
      "MemorySearch",
      "MemoryWrite",
      "MemoryDelete",
      "HttpFetch",
    ]),
    allowReadonly: true,
    askForBash: false,
    askForWrite: false,
    deniedPathPrefixes: [
      ".git",
      ".env",
      "node_modules",
      ".harness/permissions",
    ],
    deniedCommandFragments: [],
  };
}

function createChildSessionId(parentId: string, subagent: string): string {
  const safeParent = safeSegment(parentId);
  const safeSubagent = safeSegment(subagent);
  return `.sub-${safeParent}-${safeSubagent}-${randomBytes(4).toString("hex")}`;
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  return normalized || "session";
}
