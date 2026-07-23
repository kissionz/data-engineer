import { AgentGuidanceController } from "../agent/guidance.js";
import type { AgentLoop } from "../agent/loop.js";
import { CANCELLED_TEXT } from "../agent/cancellation.js";
import {
  getCompactionStats,
  type SessionCompactor,
} from "../agent/compaction.js";
import type { SessionStore } from "../agent/session.js";
import type {
  ManagedSession,
  SessionMetadata,
  SessionManager,
} from "../agent/sessionManager.js";
import type { SessionEvent } from "../protocol.js";
import type { CheckpointManager } from "../runtime/checkpoints.js";
import type { BackgroundCommandManager } from "../runtime/backgroundCommands.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SessionTelemetryObserver } from "../telemetry/index.js";
import type { InteractivePrompt } from "./interactivePrompt.js";

interface DisposableReporter {
  dispose(): void;
}

export interface InteractiveRuntime {
  session: ManagedSession;
  agent: AgentLoop;
  telemetry: SessionTelemetryObserver;
  reporter: DisposableReporter;
  sessionStore: SessionStore;
  compactor: SessionCompactor;
  checkpoints: CheckpointManager;
  backgroundTasks: BackgroundCommandManager;
  tools: ToolRegistry;
  modelName: string;
  permissionMode: string;
}

export async function runInteractiveSession(
  initialRuntime: InteractiveRuntime,
  prompt: InteractivePrompt,
  sessionManager: SessionManager,
  createRuntime: (session: ManagedSession) => InteractiveRuntime,
): Promise<void> {
  let runtime = initialRuntime;
  console.log(formatWelcome(await runtime.session.readMetadata(), runtime.permissionMode));

  try {
    while (true) {
      const task = await prompt.question("You ");
      const terminationDecision = prompt.handleTerminationAnswer(task);
      if (terminationDecision === "exit") return console.log("Bye.");
      if (terminationDecision === "continue") {
        console.log("Continuing session.");
        continue;
      }
      if (terminationDecision === "pending") {
        console.log("Please type y to exit or n to continue.");
        continue;
      }

      const trimmed = task.trim();
      if (!trimmed) continue;
      if (trimmed === "/exit" || trimmed === "/quit") return console.log("Bye.");

      if (trimmed.startsWith("/")) {
        try {
          const result = await handleCommand(
            trimmed,
            runtime,
            sessionManager,
            createRuntime,
          );
          runtime = result.runtime;
        } catch (error: unknown) {
          console.error(`Command failed: ${errorMessage(error)}`);
        }
        continue;
      }

      prompt.showSubmittedUserMessage(trimmed);
      const guidance = new AgentGuidanceController();
      const controller = prompt.beginTask((text) => guidance.submit(text));
      let result: string | undefined;
      try {
        result = await runtime.agent.run(
          trimmed,
          controller.signal,
          undefined,
          guidance,
        );
      } catch (error: unknown) {
        console.error(`Task failed: ${errorMessage(error)}`);
      } finally {
        guidance.reset();
        runtime.reporter.dispose();
        prompt.endTask(controller);
      }
      if (result === CANCELLED_TEXT) prompt.markTaskCancelled();
    }
  } finally {
    try {
      await disposeInteractiveRuntime(runtime);
    } finally {
      prompt.close();
    }
  }
}

export async function disposeInteractiveRuntime(
  runtime: InteractiveRuntime,
): Promise<void> {
  runtime.reporter.dispose();
  try {
    await runtime.backgroundTasks.dispose();
  } finally {
    try {
      await runtime.telemetry.dispose();
    } finally {
      await runtime.session.release();
    }
  }
}

async function handleCommand(
  command: string,
  runtime: InteractiveRuntime,
  sessionManager: SessionManager,
  createRuntime: (session: ManagedSession) => InteractiveRuntime,
): Promise<{ handled: boolean; runtime: InteractiveRuntime }> {
  if (command === "/help") {
    console.log(formatHelp());
    return { handled: true, runtime };
  }
  if (command === "/new") {
    return replaceRuntime(runtime, createRuntime, await sessionManager.create(), "New");
  }
  if (command === "/fork") {
    return replaceRuntime(
      runtime,
      createRuntime,
      await sessionManager.fork(runtime.session),
      "Forked",
    );
  }
  if (command === "/session") {
    console.log(formatSessionMetadata(await runtime.session.readMetadata()));
    return { handled: true, runtime };
  }
  if (command === "/rename") {
    console.log("Usage: /rename <session-title>");
    return { handled: true, runtime };
  }
  if (command.startsWith("/rename ")) {
    const metadata = await runtime.session.updateTitle(
      command.slice("/rename".length).trim(),
    );
    console.log(`Renamed session: ${metadata.title}`);
    return { handled: true, runtime };
  }
  if (command === "/sessions") {
    const sessions = await sessionManager.list();
    console.log(formatSessionList(sessions, runtime.session.id));
    return { handled: true, runtime };
  }
  if (command === "/inspect" || command.startsWith("/inspect ")) {
    const id = command.slice("/inspect".length).trim();
    console.log(formatSessionMetadata(
      !id || id === runtime.session.id
        ? await runtime.session.readMetadata()
        : await sessionManager.inspect(id),
    ));
    return { handled: true, runtime };
  }
  if (command === "/resume") {
    console.log("Usage: /resume <session-id|latest>");
    return { handled: true, runtime };
  }
  if (command.startsWith("/resume ")) {
    const requested = command.slice(8).trim();
    const target = await sessionManager.inspect(requested);
    if (target.id === runtime.session.id) {
      console.log(`Already using session: ${runtime.session.id}`);
      return { handled: true, runtime };
    }
    const next = await sessionManager.resume(target.id);
    return replaceRuntime(runtime, createRuntime, next, "Resumed");
  }
  if (command === "/permissions") {
    console.log(`Permission mode: ${runtime.permissionMode}`);
    return { handled: true, runtime };
  }
  if (command === "/model") {
    console.log(`Model: ${runtime.modelName}`);
    return { handled: true, runtime };
  }
  if (command === "/cost" || command === "/context") {
    const events = await runtime.sessionStore.load();
    console.log(
      command === "/cost"
        ? formatCost(events)
        : formatContext(events),
    );
    return { handled: true, runtime };
  }
  if (command === "/compact") {
    const before = getCompactionStats(await runtime.sessionStore.load());
    const compacted = await runtime.compactor.compactIfNeeded({ force: true });
    console.log(
      compacted
        ? `Context compacted · ${before.uncompactedEvents} active events summarized.`
        : "Context is already compact.",
    );
    return { handled: true, runtime };
  }
  if (command === "/rewind") {
    console.log(
      (await runtime.checkpoints.rewindLatestTurn(runtime.sessionStore)).message,
    );
    return { handled: true, runtime };
  }
  if (command === "/diff") {
    if (!runtime.tools.has("GitDiff")) console.log("Git diff is unavailable.");
    else console.log((await runtime.tools.execute("GitDiff", {}, { toolCallId: "interactive-diff" })).content);
    return { handled: true, runtime };
  }
  if (command === "/mcp") {
    const names = runtime.tools.list().filter((tool) => tool.source?.type === "mcp").map((tool) => tool.name);
    console.log(names.length > 0 ? names.join("\n") : "No MCP tools connected.");
    return { handled: true, runtime };
  }
  if (command === "/memory" || command.startsWith("/memory ")) {
    const query = command.slice("/memory".length).trim();
    if (!runtime.tools.has("MemorySearch")) console.log("Memory is disabled.");
    else if (!query) console.log("Usage: /memory <query>");
    else console.log((await runtime.tools.execute("MemorySearch", { query }, { toolCallId: "interactive-memory" })).content);
    return { handled: true, runtime };
  }
  console.log(`Unknown command: ${command}. Type /help.`);
  return { handled: true, runtime };
}

async function replaceRuntime(
  current: InteractiveRuntime,
  createRuntime: (session: ManagedSession) => InteractiveRuntime,
  session: ManagedSession,
  verb: string,
): Promise<{ handled: true; runtime: InteractiveRuntime }> {
  const next = createRuntime(session);
  await disposeInteractiveRuntime(current);
  console.log([
    `${verb} session`,
    formatWelcome(
      await next.session.readMetadata(),
      next.permissionMode,
    ).trim(),
  ].join("\n"));
  return { handled: true, runtime: next };
}

function formatCost(events: SessionEvent[]): string {
  const usage = events
    .filter((event) => event.type === "model_response_received")
    .map((event) => event.usage);
  const input = usage.reduce((sum, item) => sum + (item?.inputTokens ?? 0), 0);
  const output = usage.reduce((sum, item) => sum + (item?.outputTokens ?? 0), 0);
  const cost = usage.reduce((sum, item) => sum + (item?.estimatedCostUsd ?? 0), 0);
  return [
    "Usage",
    `  Input      ${formatCount(input)} tokens`,
    `  Output     ${formatCount(output)} tokens`,
    `  Estimated  $${cost.toFixed(6)}`,
  ].join("\n");
}

export function formatContext(events: SessionEvent[]): string {
  const stats = getCompactionStats(events);
  return [
    "Context",
    `  Active     ${stats.activeEvents} events · ~${formatCount(stats.estimatedActiveTokens)} tokens`,
    `  Stored     ${stats.storedEvents} events`,
    `  Compacted  ${stats.lastCompactedAt ? formatTimestamp(stats.lastCompactedAt) : "not yet"}`,
  ].join("\n");
}

export function formatWelcome(
  metadata: SessionMetadata,
  permissionMode: string,
): string {
  const label = metadata.title?.trim() || shortSessionId(metadata.id);
  return [
    "",
    `Montane Code · ${metadata.model}`,
    `${label} · ${humanizeStatus(metadata.status)} · ${permissionMode} permissions`,
    "Type a task, or /help for commands. Ctrl+O toggles tool details.",
    "",
  ].join("\n");
}

export function formatHelp(): string {
  return [
    "Commands",
    "  Sessions   /new  /fork  /resume <id>  /rename <title>  /sessions",
    "  Details    /session  /inspect [id]  /model  /permissions",
    "  Context    /context  /compact  /cost  /memory <query>",
    "  Workspace  /diff  /rewind  /mcp",
    "  Exit       /exit",
    "",
    "While Montane is working",
    "  Type a message to guide the current task.",
    "  /tools or Ctrl+O toggles tool details. /cancel stops the task.",
  ].join("\n");
}

export function formatSessionMetadata(metadata: SessionMetadata): string {
  return [
    metadata.title?.trim() || "Untitled session",
    `  ID         ${metadata.id}`,
    `  Status     ${humanizeStatus(metadata.status)}`,
    `  Model      ${metadata.model}`,
    `  Workspace  ${metadata.workspaceRoot}`,
    `  Updated    ${formatTimestamp(metadata.updatedAt)}`,
    ...(metadata.parentSessionId
      ? [`  Forked from ${metadata.parentSessionId}`]
      : []),
  ].join("\n");
}

export function formatSessionList(
  sessions: SessionMetadata[],
  currentSessionId: string,
): string {
  if (sessions.length === 0) return "No saved sessions.";

  return [
    "Sessions",
    ...sessions.map((metadata) => {
      const marker = metadata.id === currentSessionId ? "●" : " ";
      const label = metadata.title?.trim() || shortSessionId(metadata.id);
      return `${marker} ${label} · ${humanizeStatus(metadata.status)} · ${metadata.model} · ${formatTimestamp(metadata.updatedAt)}`;
    }),
  ].join("\n");
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  }
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

function shortSessionId(id: string): string {
  const suffix = id.split("-").at(-1);
  if (suffix && suffix.length >= 4) return suffix;
  return id.length <= 12 ? id : id.slice(-8);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function humanizeStatus(status: SessionMetadata["status"]): string {
  return status.replaceAll("_", " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
