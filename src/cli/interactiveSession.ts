import { AgentGuidanceController } from "../agent/guidance.js";
import type { AgentLoop } from "../agent/loop.js";
import { CANCELLED_TEXT } from "../agent/cancellation.js";
import {
  estimateSessionEventTokens,
  type SessionCompactor,
} from "../agent/compaction.js";
import type { SessionStore } from "../agent/session.js";
import type {
  ManagedSession,
  SessionManager,
} from "../agent/sessionManager.js";
import type { SessionEvent } from "../agent/types.js";
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
  console.log(`Montane Code session started. Session: ${runtime.session.id}`);
  printHelp();

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
    printHelp();
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
    console.log(JSON.stringify(await runtime.session.readMetadata(), null, 2));
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
    const rows = sessions.map((metadata) => {
      return [
        metadata.id,
        metadata.status,
        metadata.model,
        ...(metadata.title ? [metadata.title] : []),
      ].join("\t");
    });
    console.log(rows.length > 0 ? rows.join("\n") : "[No sessions]");
    return { handled: true, runtime };
  }
  if (command === "/inspect" || command.startsWith("/inspect ")) {
    const id = command.slice("/inspect".length).trim();
    console.log(JSON.stringify(
      !id || id === runtime.session.id
        ? await runtime.session.readMetadata()
        : await sessionManager.inspect(id),
      null,
      2,
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
    console.log(command === "/cost" ? formatCost(events) : formatContext(events));
    return { handled: true, runtime };
  }
  if (command === "/compact") {
    const compacted = await runtime.compactor.compactIfNeeded({ force: true });
    console.log(compacted ? "Session context compacted." : "Nothing to compact.");
    return { handled: true, runtime };
  }
  if (command === "/undo") {
    console.log((await runtime.checkpoints.undoLatest()).message);
    return { handled: true, runtime };
  }
  if (command === "/diff") {
    if (!runtime.tools.has("GitDiff")) console.log("Git diff is unavailable.");
    else console.log((await runtime.tools.execute("GitDiff", {}, { toolCallId: "interactive-diff" })).content);
    return { handled: true, runtime };
  }
  if (command === "/mcp") {
    const names = runtime.tools.list().filter((tool) => tool.source?.type === "mcp").map((tool) => tool.name);
    console.log(names.length > 0 ? names.join("\n") : "[No MCP tools]");
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
  console.log(`${verb} session: ${next.session.id}`);
  return { handled: true, runtime: next };
}

function formatCost(events: SessionEvent[]): string {
  const usage = events
    .filter((event) => event.type === "model_response_received")
    .map((event) => event.usage);
  const input = usage.reduce((sum, item) => sum + (item?.inputTokens ?? 0), 0);
  const output = usage.reduce((sum, item) => sum + (item?.outputTokens ?? 0), 0);
  const cost = usage.reduce((sum, item) => sum + (item?.estimatedCostUsd ?? 0), 0);
  return `Input tokens: ${input}\nOutput tokens: ${output}\nEstimated cost: $${cost.toFixed(6)}`;
}

function formatContext(events: SessionEvent[]): string {
  return `Events: ${events.length}\nEstimated stored context: ${estimateSessionEventTokens(events)} tokens`;
}

function printHelp(): void {
  console.log([
    "Commands: /help, /new, /fork, /resume <id>, /rename <title>, /session, /sessions, /inspect [id]",
    "Runtime: /model, /permissions, /cost, /context, /compact, /memory <query>, /mcp",
    "Workspace: /diff, /undo, /exit",
    "During a run: /tools toggles tool details, /cancel stops.",
  ].join("\n"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
