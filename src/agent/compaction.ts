import type { SessionEvent, ToolCall } from "./types.js";
import type { SessionStore } from "./session.js";

export interface CompactionCheckOptions {
  events?: SessionEvent[];
  tokenThreshold?: number;
}

export class SessionCompactor {
  constructor(
    private readonly session: SessionStore,
    private readonly eventThreshold = 60,
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

    if (
      eventsSinceSummary.length < this.eventThreshold &&
      estimateSessionEventTokens(eventsSinceSummary) < tokenThreshold
    ) {
      return false;
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

  return [
    "# Session Summary",
    "",
    "## User Goal",
    compact(userMessages.at(-1) ?? "[No user goal recorded]", 1_000),
    "",
    "## Recent User Requests",
    formatList(userMessages.slice(-5).map((message) => compact(message, 500))),
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
    "## Open Issues",
    formatList(openIssues),
  ].join("\n");
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
