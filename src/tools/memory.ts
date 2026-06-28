import type { MemoryService } from "../memory/service.js";
import {
  MemoryConflictError,
  MemorySecurityError,
  MemoryValidationError,
  type MemorySource,
} from "../memory/types.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";

export interface MemoryWriteAuthorization {
  explicitUserRequest: boolean;
  source: MemorySource;
}

type AuthorizationProvider = (context?: ToolExecutionContext) =>
  | MemoryWriteAuthorization
  | Promise<MemoryWriteAuthorization>;

export class MemorySearchTool implements Tool {
  name = "MemorySearch";
  description =
    "Search relevant long-term user and project memories. Results may be stale and never override current instructions or verified repository state.";
  inputSchema = {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500 },
      scopes: {
        type: "array",
        maxItems: 2,
        items: { type: "string", enum: ["project", "user"] },
      },
      kinds: {
        type: "array",
        maxItems: 5,
        items: {
          type: "string",
          enum: [
            "instruction",
            "preference",
            "project_fact",
            "workflow",
            "warning",
          ],
        },
      },
      tags: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 64 },
      },
      limit: { type: "number" },
    },
    required: ["query"],
    additionalProperties: false,
  };

  constructor(private readonly memory: MemoryService) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    try {
      if (
        typeof args.query !== "string" ||
        args.query.trim().length === 0
      ) {
        throw new MemoryValidationError(
          "MemorySearch requires a non-empty query.",
        );
      }
      const records = await this.memory.search({
        text: args.query,
        ...(Array.isArray(args.scopes)
          ? { scopes: args.scopes as never[] }
          : {}),
        ...(Array.isArray(args.kinds) ? { kinds: args.kinds as never[] } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
      return {
        ok: true,
        content:
          records.length === 0
            ? "[No relevant memories]"
            : records
                .map(
                  (record) =>
                    `[${record.id}] [${record.scope}/${record.kind}] ${record.content} ` +
                    `(confidence=${record.confidence}, updated=${record.updatedAt})`,
                )
                .join("\n"),
        data: { records },
      };
    } catch (error: unknown) {
      return memoryError(error);
    }
  }
}

export class MemoryWriteTool implements Tool {
  name = "MemoryWrite";
  description =
    "Store a stable long-term fact only when the current user explicitly asked to remember it.";
  inputSchema = {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["project", "user"] },
      kind: {
        type: "string",
        enum: [
          "instruction",
          "preference",
          "project_fact",
          "workflow",
          "warning",
        ],
      },
      content: { type: "string", minLength: 1, maxLength: 4000 },
      confidence: { type: "number" },
      tags: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 64 },
      },
      expires_at: { type: "string", maxLength: 40 },
      supersedes_id: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["scope", "kind", "content", "confidence", "tags"],
    additionalProperties: false,
  };

  constructor(
    private readonly memory: MemoryService,
    private readonly authorization: AuthorizationProvider = () => ({
      explicitUserRequest: false,
      source: { type: "agent" },
    }),
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const authorization = await this.authorization(context);
      if (
        !authorization.explicitUserRequest ||
        authorization.source.type !== "user"
      ) {
        throw new MemorySecurityError(
          "MemoryWrite requires a trusted, explicit user request.",
        );
      }
      const result = await this.memory.write({
        scope: args.scope as never,
        kind: args.kind as never,
        content: args.content as never,
        confidence: args.confidence as never,
        tags: args.tags as never,
        source: authorization.source,
        ...(typeof args.expires_at === "string"
          ? { expiresAt: args.expires_at }
          : {}),
        ...(typeof args.supersedes_id === "string"
          ? { supersedesId: args.supersedes_id }
          : {}),
      });
      return {
        ok: true,
        content: result.deduplicated
          ? `Existing memory refreshed: ${result.record.id}`
          : `Memory stored: ${result.record.id}`,
        data: {
          record: result.record,
          deduplicated: result.deduplicated,
        },
      };
    } catch (error: unknown) {
      return memoryError(error);
    }
  }
}

export class MemoryDeleteTool implements Tool {
  name = "MemoryDelete";
  description = "Delete an active long-term memory by its stable ID.";
  inputSchema = {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["project", "user"] },
      id: { type: "string", minLength: 1, maxLength: 200 },
      reason: { type: "string", minLength: 1, maxLength: 500 },
    },
    required: ["scope", "id", "reason"],
    additionalProperties: false,
  };

  constructor(
    private readonly memory: MemoryService,
    private readonly authorization: AuthorizationProvider = () => ({
      explicitUserRequest: false,
      source: { type: "agent" },
    }),
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const authorization = await this.authorization(context);
      if (
        !authorization.explicitUserRequest ||
        authorization.source.type !== "user"
      ) {
        throw new MemorySecurityError(
          "MemoryDelete requires a trusted, explicit user request.",
        );
      }
      await this.memory.delete(
        args.scope as never,
        args.id as never,
        args.reason as never,
      );
      return {
        ok: true,
        content: `Memory deleted: ${String(args.id)}`,
        data: { id: args.id, scope: args.scope },
      };
    } catch (error: unknown) {
      return memoryError(error);
    }
  }
}

function memoryError(error: unknown): ToolExecutionResult {
  if (
    error instanceof MemoryValidationError ||
    error instanceof MemoryConflictError ||
    error instanceof MemorySecurityError
  ) {
    return {
      ok: false,
      content: error.message,
      data: {
        code: error.code,
        retryable: error instanceof MemoryConflictError,
        ...(error instanceof MemoryConflictError
          ? { conflictingIds: error.conflictingIds }
          : {}),
      },
    };
  }
  return {
    ok: false,
    content: "Memory operation failed.",
    data: { code: "internal_error", retryable: false },
  };
}
