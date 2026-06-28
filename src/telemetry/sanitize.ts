import { isDeepStrictEqual } from "node:util";
import type {
  TelemetryEvent,
  TelemetryOutcome,
} from "./types.js";

const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 120;
const MAX_CODE_LENGTH = 160;
const MAX_REDACTION_LOOKAHEAD = 4_096;
const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/gi,
  /\b(?:gh[pousr]|github_pat|npm)_[A-Za-z0-9_]{16,}\b/gi,
  /\b(?:glpat|xox[baprs])-[A-Za-z0-9_-]{12,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret|credential|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|credential)=)[^&#\s]+/gi,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi,
];

const EVENT_KEYS: Record<TelemetryEvent["type"], readonly string[]> = {
  task_started: ["type", "taskId", "sessionId", "trigger"],
  task_finished: [
    "type",
    "taskId",
    "sessionId",
    "outcome",
    "durationMs",
    "modelCallCount",
    "toolCallCount",
    "errorCode",
  ],
  model_request_started: [
    "type",
    "taskId",
    "requestId",
    "provider",
    "model",
    "attempt",
    "maxOutputTokens",
  ],
  model_request_finished: [
    "type",
    "taskId",
    "requestId",
    "provider",
    "model",
    "outcome",
    "durationMs",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "estimatedCostUsd",
    "stopReason",
    "errorCode",
  ],
  tool_started: ["type", "taskId", "toolCallId", "toolName", "effect"],
  tool_finished: [
    "type",
    "taskId",
    "toolCallId",
    "toolName",
    "outcome",
    "durationMs",
    "errorCode",
  ],
  permission_requested: [
    "type",
    "taskId",
    "toolCallId",
    "toolName",
    "fingerprint",
    "scope",
  ],
  permission_resolved: [
    "type",
    "taskId",
    "toolCallId",
    "toolName",
    "decision",
    "durationMs",
  ],
  compaction_started: [
    "type",
    "taskId",
    "trigger",
    "inputTokenCount",
    "messageCount",
  ],
  compaction_finished: [
    "type",
    "taskId",
    "outcome",
    "durationMs",
    "inputTokenCount",
    "outputTokenCount",
    "messagesBefore",
    "messagesAfter",
    "errorCode",
  ],
  cancellation_requested: [
    "type",
    "taskId",
    "source",
    "phase",
    "reasonCode",
  ],
  cancellation_finished: ["type", "taskId", "phase", "durationMs"],
};

export function sanitizeTelemetryEvent(value: unknown): TelemetryEvent {
  const event = requireRecord(value, "telemetry event");
  const type = requireEnum(
    event.type,
    "type",
    Object.keys(EVENT_KEYS) as TelemetryEvent["type"][],
  );
  requireExactKeys(event, EVENT_KEYS[type]);

  switch (type) {
    case "task_started":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        sessionId: optionalText(event.sessionId, "sessionId", MAX_ID_LENGTH),
        trigger: requireEnum(
          event.trigger,
          "trigger",
          ["user", "resume", "subagent", "automation", "unknown"] as const,
        ),
      });
    case "task_finished":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        sessionId: optionalText(event.sessionId, "sessionId", MAX_ID_LENGTH),
        outcome: outcome(event.outcome),
        durationMs: count(event.durationMs, "durationMs"),
        modelCallCount: optionalCount(event.modelCallCount, "modelCallCount"),
        toolCallCount: optionalCount(event.toolCallCount, "toolCallCount"),
        errorCode: optionalText(event.errorCode, "errorCode", MAX_CODE_LENGTH),
      });
    case "model_request_started":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        requestId: optionalText(event.requestId, "requestId", MAX_ID_LENGTH),
        provider: text(event.provider, "provider", MAX_NAME_LENGTH),
        model: text(event.model, "model", MAX_NAME_LENGTH),
        attempt: count(event.attempt, "attempt"),
        maxOutputTokens: optionalCount(event.maxOutputTokens, "maxOutputTokens"),
      });
    case "model_request_finished":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        requestId: optionalText(event.requestId, "requestId", MAX_ID_LENGTH),
        provider: text(event.provider, "provider", MAX_NAME_LENGTH),
        model: text(event.model, "model", MAX_NAME_LENGTH),
        outcome: outcome(event.outcome),
        durationMs: count(event.durationMs, "durationMs"),
        inputTokens: optionalCount(event.inputTokens, "inputTokens"),
        outputTokens: optionalCount(event.outputTokens, "outputTokens"),
        cacheReadTokens: optionalCount(event.cacheReadTokens, "cacheReadTokens"),
        estimatedCostUsd: optionalNonNegativeFinite(
          event.estimatedCostUsd,
          "estimatedCostUsd",
        ),
        stopReason: optionalText(event.stopReason, "stopReason", MAX_CODE_LENGTH),
        errorCode: optionalText(event.errorCode, "errorCode", MAX_CODE_LENGTH),
      });
    case "tool_started":
      return {
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        toolCallId: text(event.toolCallId, "toolCallId", MAX_ID_LENGTH),
        toolName: text(event.toolName, "toolName", MAX_NAME_LENGTH),
        effect: requireEnum(
          event.effect,
          "effect",
          ["readonly", "side_effect", "unknown"] as const,
        ),
      };
    case "tool_finished":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        toolCallId: text(event.toolCallId, "toolCallId", MAX_ID_LENGTH),
        toolName: text(event.toolName, "toolName", MAX_NAME_LENGTH),
        outcome: outcome(event.outcome),
        durationMs: count(event.durationMs, "durationMs"),
        errorCode: optionalText(event.errorCode, "errorCode", MAX_CODE_LENGTH),
      });
    case "permission_requested":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        toolCallId: text(event.toolCallId, "toolCallId", MAX_ID_LENGTH),
        toolName: text(event.toolName, "toolName", MAX_NAME_LENGTH),
        fingerprint: optionalText(
          event.fingerprint,
          "fingerprint",
          MAX_ID_LENGTH,
        ),
        scope: text(event.scope, "scope", MAX_NAME_LENGTH),
      });
    case "permission_resolved":
      return {
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        toolCallId: text(event.toolCallId, "toolCallId", MAX_ID_LENGTH),
        toolName: text(event.toolName, "toolName", MAX_NAME_LENGTH),
        decision: requireEnum(
          event.decision,
          "decision",
          ["reject", "allow_once", "allow_session"] as const,
        ),
        durationMs: count(event.durationMs, "durationMs"),
      };
    case "compaction_started":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        trigger: requireEnum(
          event.trigger,
          "trigger",
          ["token_limit", "manual", "automatic"] as const,
        ),
        inputTokenCount: optionalCount(
          event.inputTokenCount,
          "inputTokenCount",
        ),
        messageCount: count(event.messageCount, "messageCount"),
      });
    case "compaction_finished":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        outcome: outcome(event.outcome),
        durationMs: count(event.durationMs, "durationMs"),
        inputTokenCount: optionalCount(
          event.inputTokenCount,
          "inputTokenCount",
        ),
        outputTokenCount: optionalCount(
          event.outputTokenCount,
          "outputTokenCount",
        ),
        messagesBefore: count(event.messagesBefore, "messagesBefore"),
        messagesAfter: optionalCount(event.messagesAfter, "messagesAfter"),
        errorCode: optionalText(event.errorCode, "errorCode", MAX_CODE_LENGTH),
      });
    case "cancellation_requested":
      return compact({
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        source: requireEnum(
          event.source,
          "source",
          ["user", "timeout", "system", "parent"] as const,
        ),
        phase: phase(event.phase),
        reasonCode: optionalText(event.reasonCode, "reasonCode", MAX_CODE_LENGTH),
      });
    case "cancellation_finished":
      return {
        type,
        taskId: text(event.taskId, "taskId", MAX_ID_LENGTH),
        phase: phase(event.phase),
        durationMs: count(event.durationMs, "durationMs"),
      };
  }
}

export function isCanonicalTelemetryEvent(value: unknown): boolean {
  try {
    return isDeepStrictEqual(value, sanitizeTelemetryEvent(value));
  } catch {
    return false;
  }
}

export function redactTelemetryString(value: string, maxLength: number): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 3) {
    throw new Error("maxLength must be an integer of at least 3.");
  }
  const boundedInput = value.slice(0, maxLength + MAX_REDACTION_LOOKAHEAD);
  let redacted = boundedInput.normalize("NFKC").replace(/\0/g, "");
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && prefix.length > 0
        ? `${prefix}${REDACTED}`
        : REDACTED,
    );
  }
  redacted = redacted.replace(/\s+/g, " ").trim();
  const characters = [...redacted];
  return characters.length <= maxLength
    ? redacted
    : `${characters.slice(0, Math.max(0, maxLength - 3)).join("")}...`;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) {
    throw new Error(`Telemetry field ${extra} is not allowed.`);
  }
}

function text(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  const sanitized = redactTelemetryString(value, maxLength);
  if (sanitized.length === 0) {
    throw new Error(`${name} cannot be empty.`);
  }
  return sanitized;
}

function optionalText(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : text(value, name, maxLength);
}

function count(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function optionalCount(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : count(value, name);
}

function optionalNonNegativeFinite(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as T[number];
}

function outcome(value: unknown): TelemetryOutcome {
  return requireEnum(
    value,
    "outcome",
    ["succeeded", "failed", "cancelled", "rejected"] as const,
  );
}

function phase(
  value: unknown,
): "queued" | "model" | "tool" | "permission" | "compaction" | "unknown" {
  return requireEnum(
    value,
    "phase",
    ["queued", "model", "tool", "permission", "compaction", "unknown"] as const,
  );
}

function compact<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & T {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & T;
}
