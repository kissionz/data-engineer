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
import { SubagentSpecLoader } from "../subagents/loader.js";
import {
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
      `Run a bounded read-only subagent. Available role names: ` +
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
    const spec =
      typeof args.subagent === "string"
        ? this.specs.get(args.subagent)
        : undefined;
    if (!spec || typeof args.task !== "string" || !args.task.trim()) {
      return {
        ok: false,
        content: "subagent and a non-empty task are required.",
        data: { reason: "invalid_subagent_task" },
      };
    }

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
      ).run(args.task.trim(), context?.signal, context?.budget);
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
      },
    };
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
  if (capabilities.ripgrep && requested.has("Grep")) {
    tools.register(new GrepTool(workspace, executor));
  }
  if (capabilities.ripgrep && requested.has("Glob")) {
    tools.register(new GlobTool(workspace, executor));
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
