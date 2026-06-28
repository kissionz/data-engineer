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
import { CODE_REVIEWER_SPEC } from "../subagents/spec.js";
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
  description =
    "Run a bounded read-only subagent for an independent code review task.";
  inputSchema = {
    type: "object",
    properties: {
      subagent: {
        type: "string",
        enum: [CODE_REVIEWER_SPEC.name],
      },
      task: { type: "string", minLength: 1, maxLength: 4_000 },
    },
    required: ["subagent", "task"],
    additionalProperties: false,
  };

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
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (
      args.subagent !== CODE_REVIEWER_SPEC.name ||
      typeof args.task !== "string" ||
      !args.task.trim()
    ) {
      return {
        ok: false,
        content: "subagent and a non-empty task are required.",
        data: { reason: "invalid_subagent_task" },
      };
    }

    const tools = createReviewerTools(
      this.workspace,
      this.executor,
      this.runtimeCapabilities,
    );
    const childSessionId = createChildSessionId(
      this.parentSessionId,
      CODE_REVIEWER_SPEC.name,
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
    const result = await new AgentLoop(
      this.model,
      tools,
      new PermissionGate(readonlyPolicy()),
      new ContextBuilder(
        this.workspace.root,
        30,
        CODE_REVIEWER_SPEC.systemPrompt,
      ),
      new SessionStore(
        childSessionPath,
        childSessionId,
        telemetry
          ? async (event) => {
              void telemetry.observe(event);
            }
          : undefined,
      ),
      CODE_REVIEWER_SPEC.maxTurns,
      async () => "reject",
    ).run(args.task.trim(), context?.signal, context?.budget);
    const truncated = result.length > this.maxResultChars;

    if (result === CANCELLED_TEXT) {
      return {
        ok: false,
        content: CANCELLED_TEXT,
        data: {
          code: "cancelled",
          retryable: false,
          subagent: CODE_REVIEWER_SPEC.name,
          childSessionId,
        },
      };
    }

    return {
      ok: true,
      content: truncated
        ? `${result.slice(0, this.maxResultChars)}\n[Subagent result truncated]`
        : result,
      data: {
        subagent: CODE_REVIEWER_SPEC.name,
        childSessionId,
        truncated,
      },
    };
  }
}

function createReviewerTools(
  workspace: Workspace,
  executor: CommandExecutor,
  capabilities: RuntimeCapabilities,
): ToolRegistry {
  const tools = new ToolRegistry();
  const skills = new SkillLoader(workspace);
  tools.register(new ReadTool(workspace));
  if (capabilities.ripgrep) {
    tools.register(new GrepTool(workspace, executor));
    tools.register(new GlobTool(workspace, executor));
  }
  if (capabilities.git && capabilities.gitRepository) {
    tools.register(new GitStatusTool(workspace, executor));
    tools.register(new GitDiffTool(workspace, executor));
  }
  tools.register(new SkillListTool(skills));
  tools.register(new SkillLoadTool(skills));
  return tools;
}

function readonlyPolicy(): PermissionPolicy {
  return {
    allowedTools: new Set([
      "Read",
      "Grep",
      "Glob",
      "GitStatus",
      "GitDiff",
      "SkillList",
      "SkillLoad",
    ]),
    deniedTools: new Set(["Write", "Edit", "Bash", "Task", "TodoWrite"]),
    allowReadonly: true,
    askForBash: false,
    askForWrite: false,
    deniedPathPrefixes: [".git", ".env", "node_modules"],
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
