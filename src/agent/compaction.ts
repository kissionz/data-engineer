import type { SessionEvent, ToolCall } from "./types.js";
import type { SessionStore } from "./session.js";

export interface CompactionCheckOptions {
  events?: SessionEvent[];
  tokenThreshold?: number;
  force?: boolean;
  beforeCompact?: (events: SessionEvent[]) => Promise<boolean> | boolean;
}

export class SessionCompactor {
  constructor(
    private readonly session: SessionStore,
    private readonly eventThreshold: number | null = 60,
    private readonly tokenThreshold = 24_000,
  ) {}

  async compactIfNeeded(
    options: CompactionCheckOptions = {},
  ): Promise<boolean> {
    const events = options.events ?? await this.session.load();
    const latestSummaryIndex = findLatestSummaryIndex(events);
    const eventsSinceSummary = events
      .slice(latestSummaryIndex + 1)
      .filter((event) => event.type !== "summary");
    const tokenThreshold =
      options.tokenThreshold ?? this.tokenThreshold;

    if (eventsSinceSummary.length === 0) {
      return false;
    }
    if (
      !options.force &&
      (this.eventThreshold === null ||
        eventsSinceSummary.length < this.eventThreshold) &&
      estimateSessionEventTokens(eventsSinceSummary) < tokenThreshold
    ) {
      return false;
    }
    if (options.beforeCompact) {
      const proceed = await options.beforeCompact(eventsSinceSummary);
      if (!proceed) {
        return false;
      }
    }

    await this.session.append({
      type: "summary",
      text: buildSessionSummary(events),
    });
    return true;
  }
}

export function estimateSessionEventTokens(events: SessionEvent[]): number {
  return Math.ceil(JSON.stringify(events).length / 4);
}

export function buildSessionSummary(events: SessionEvent[]): string {
  const userMessages = events
    .filter((event) => event.type === "user_message")
    .map((event) => event.text);
  const toolCalls = events
    .filter((event) => event.type === "assistant_tool_calls")
    .flatMap((event) => event.toolCalls);
  const filesRead = uniqueToolValues(toolCalls, ["Read"], "file_path");
  const filesModified = uniqueToolValues(
    toolCalls,
    ["Write", "Edit"],
    "file_path",
  );
  const commands = uniqueToolValues(toolCalls, ["Bash"], "command");
  const latestFinal = [...events]
    .reverse()
    .find(
      (
        event,
      ): event is Extract<SessionEvent, { type: "assistant_final" }> =>
        event.type === "assistant_final",
    );
  const openIssues = events
    .filter(
      (
        event,
      ): event is Extract<SessionEvent, { type: "tool_result" }> =>
        event.type === "tool_result" && !event.ok,
    )
    .slice(-10)
    .map((event) => `${event.name}: ${compact(event.content, 240)}`);
  const latestTodos = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "tool_result" &&
        event.name === "TodoWrite" &&
        Array.isArray(event.data?.todos),
    );
  const todos = latestTodos?.type === "tool_result"
    ? formatTodos(latestTodos.data?.todos)
    : [];
  const approvals = events
    .filter(
      (event): event is Extract<SessionEvent, { type: "approval_resolved" }> =>
        event.type === "approval_resolved",
    )
    .slice(-20)
    .map((event) => `${event.scope}: ${event.decision}`);
  const verification = events
    .filter(
      (event): event is Extract<SessionEvent, { type: "tool_result" }> =>
        event.type === "tool_result" &&
        ["Bash", "GitDiff", "GitStatus"].includes(event.name),
    )
    .slice(-10)
    .map(
      (event) =>
        `${event.name} (${event.ok ? "passed" : "failed"}): ${compact(event.content, 300)}`,
    );
  const pendingCalls = pendingToolCalls(events).map(
    (call) => `${call.name} (${call.id})`,
  );
  const nextAction = todos.find((todo) => todo.startsWith("in_progress:")) ??
    todos.find((todo) => todo.startsWith("pending:")) ??
    "Re-read the latest user request and verify repository state.";

  return [
    "# Session Summary",
    "",
    "## User Goal",
    compact(userMessages.at(-1) ?? "[No user goal recorded]", 1_000),
    "",
    "## Recent User Requests",
    formatList(userMessages.slice(-5).map((message) => compact(message, 500))),
    "",
    "## Active Constraints and Decisions",
    formatList(userMessages.slice(-5).map((message) => compact(message, 500))),
    "",
    "## Todo State",
    formatList(todos),
    "",
    "## Files Read",
    formatList(filesRead.slice(-100)),
    "",
    "## Files Modified",
    formatList(filesModified.slice(-100)),
    "",
    "## Commands Run",
    formatList(commands.slice(-20).map((command) => compact(command, 300))),
    "",
    "## Current Status",
    latestFinal ? compact(latestFinal.text, 1_000) : "[No final status recorded]",
    "",
    "## Approval Decisions",
    formatList(approvals),
    "",
    "## Verification Evidence",
    formatList(verification),
    "",
    "## Pending Tool State",
    formatList(pendingCalls),
    "",
    "## Open Issues",
    formatList(openIssues),
    "",
    "## Next Action",
    nextAction,
  ].join("\n");
}

function formatTodos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.content === "string" &&
      ["pending", "in_progress", "done"].includes(String(record.status))
      ? [`${String(record.status)}: ${compact(record.content, 300)}`]
      : [];
  });
}

function pendingToolCalls(events: SessionEvent[]): ToolCall[] {
  const pending = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type === "assistant_tool_calls") {
      for (const call of event.toolCalls) pending.set(call.id, call);
    } else if (event.type === "tool_result") {
      pending.delete(event.toolCallId);
    }
  }
  return [...pending.values()];
}

function uniqueToolValues(
  calls: ToolCall[],
  toolNames: string[],
  argumentName: string,
): string[] {
  const values = calls
    .filter((call) => toolNames.includes(call.name))
    .map((call) => call.args[argumentName])
    .filter((value): value is string => typeof value === "string" && Boolean(value));

  return [...new Set(values)];
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function compact(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

function findLatestSummaryIndex(events: SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "summary") {
      return index;
    }
  }

  return -1;
}
