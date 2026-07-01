import { createHash } from "node:crypto";
import { ModelRequestError } from "../model/base.js";
import type {
  SessionEvent,
  ToolCall,
  ToolResult,
} from "./types.js";

export interface ToolCallRecord {
  call: ToolCall;
  fingerprint: string;
  started: boolean;
  result?: ToolResult;
  collision?: boolean;
}

export function buildToolCallIndex(
  events: SessionEvent[],
): Map<string, ToolCallRecord> {
  const records = new Map<string, ToolCallRecord>();
  for (const event of events) {
    if (event.type === "assistant_tool_calls") {
      for (const call of event.toolCalls) {
        const fingerprint = toolCallFingerprint(call);
        const current = records.get(call.id);
        records.set(call.id, current
          ? {
              call,
              fingerprint,
              started: false,
              collision: true,
            }
          : {
              call,
              fingerprint,
              started: false,
            });
      }
    } else if (event.type === "tool_execution_started") {
      const current = records.get(event.toolCall.id);
      if (current && current.fingerprint !== event.fingerprint) {
        current.collision = true;
        current.started = true;
        continue;
      }
      records.set(event.toolCall.id, {
        call: event.toolCall,
        fingerprint: event.fingerprint,
        started: true,
        result: current?.result,
        collision: current?.collision,
      });
    } else if (event.type === "tool_result") {
      const current = records.get(event.toolCallId);
      if (current && !current.result) {
        current.result = {
          toolCallId: event.toolCallId,
          name: event.name,
          ok: event.ok,
          content: event.content,
          data: event.data,
        };
      }
    }
  }
  return records;
}

export function pendingApprovalRequests(
  events: SessionEvent[],
): Array<Extract<SessionEvent, { type: "approval_requested" }>> {
  const pending = new Map<
    string,
    Extract<SessionEvent, { type: "approval_requested" }>
  >();
  for (const event of events) {
    if (event.type === "approval_requested") {
      pending.set(event.toolCallId, event);
    } else if (
      event.type === "approval_resolved" ||
      event.type === "tool_result"
    ) {
      pending.delete(event.toolCallId);
    }
  }
  return [...pending.values()];
}

export function toolCallFingerprint(call: ToolCall): string {
  return createHash("sha256")
    .update(`${call.name}\0${stableSerialize(call.args)}`)
    .digest("hex");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function toolEffect(name: string): "readonly" | "side_effect" {
  return [
    "Read",
    "ListDirectory",
    "Grep",
    "Glob",
    "GitStatus",
    "GitDiff",
    "TodoRead",
    "SkillList",
    "MemorySearch",
    "HttpFetch",
  ].includes(name)
    ? "readonly"
    : "side_effect";
}

export function sessionApprovalAllowed(call: { name: string }): boolean {
  return call.name !== "HttpFetch";
}

export function explicitlyRequestsSubagent(userTask: string): boolean {
  const normalized = userTask.normalize("NFKC").trimStart().slice(0, 16_000);
  if (!/^\/subagent(?:\s+)\S/iu.test(normalized)) {
    return false;
  }
  const task = normalized.replace(/^\/subagent(?:\s+)/iu, "");
  return !/(?:^|[。！？.!?\n]\s*)(?:(?:actually[,\s]+)?(?:don't|do\s+not|cancel|never\s+mind)\b|算了|取消|不要了|停止创建)/iu.test(
    task,
  );
}

export function needsGitDiffReview(events: SessionEvent[]): boolean {
  let latestModification = -1;
  let latestReview = -1;
  let lastFinal = -1;
  events.forEach((event, index) => {
    if (event.type === "assistant_final") {
      lastFinal = index;
    }
  });
  events.forEach((event, index) => {
    if (index <= lastFinal) {
      return;
    }
    if (
      event.type === "tool_result" &&
      event.ok &&
      (event.name === "Edit" || event.name === "Write")
    ) {
      latestModification = index;
    }
    if (
      (event.type === "tool_result" && event.name === "GitDiff") ||
      (event.type === "harness_message" && event.kind === "git_diff_review")
    ) {
      latestReview = index;
    }
  });
  return latestModification > latestReview;
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replaceAll(/\p{Cc}/gu, " ").trim();
  return normalized.length <= 2_000
    ? normalized
    : `${normalized.slice(0, 1_997)}...`;
}

export function modelRetryDelay(error: unknown, attempt: number): number {
  if (
    error instanceof ModelRequestError &&
    error.retryAfterMs !== undefined
  ) {
    return error.retryAfterMs;
  }
  const base = Math.min(5_000, 250 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function estimateTokens(value: unknown): number {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.max(1, Math.ceil(serialized.length / 4));
}
