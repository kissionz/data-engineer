import {
  SkillLoader,
  SkillLoaderError,
} from "../skills/loader.js";
import type { Workspace } from "../runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "./base.js";

type SkillSource = SkillLoader | Workspace | string;

export class SkillListTool implements Tool {
  name = "SkillList";
  description = "List available workspace skills.";
  inputSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  private readonly loader: SkillLoader;

  constructor(source: SkillSource) {
    this.loader = source instanceof SkillLoader ? source : new SkillLoader(source);
  }

  async execute(_args: Record<string, unknown>): Promise<ToolExecutionResult> {
    try {
      const skills = await this.loader.list();

      return {
        ok: true,
        content:
          skills.length === 0
            ? "No skills available."
            : skills
                .map((skill) => `${skill.name}: ${skill.description}`)
                .join("\n"),
        data: { skills },
      };
    } catch (error) {
      return skillErrorResult(error);
    }
  }
}

export class SkillLoadTool implements Tool {
  name = "SkillLoad";
  description = "Load a workspace skill's instructions.";
  inputSchema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
    },
    required: ["name"],
    additionalProperties: false,
  };

  private readonly loader: SkillLoader;

  constructor(source: SkillSource) {
    this.loader = source instanceof SkillLoader ? source : new SkillLoader(source);
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (typeof args.name !== "string") {
      return {
        ok: false,
        content: "name must be a string.",
        data: { reason: "invalid_name" },
      };
    }

    try {
      const skill = await this.loader.load(args.name);

      return {
        ok: true,
        content: skill.content,
        data: {
          skill: {
            name: skill.name,
            description: skill.description,
            metadata: skill.metadata,
            path: skill.path,
          },
        },
      };
    } catch (error) {
      return skillErrorResult(error);
    }
  }
}

function skillErrorResult(error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : "Unable to read skill.";

  return {
    ok: false,
    content: message,
    data: {
      reason:
        error instanceof SkillLoaderError ? error.code : "skill_read_failed",
    },
  };
}
