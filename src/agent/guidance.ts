import type { ContextBuilder } from "./context.js";
import type { SessionStore } from "./session.js";
import { estimateTokens } from "./loopState.js";
import type { AgentMessage, SessionEvent } from "../protocol.js";

export interface AgentGuidance {
  readonly signal: AbortSignal;
  submit(text: string): void;
  drain(): string[];
  reset(): void;
}

export class AgentGuidanceController implements AgentGuidance {
  private controller = new AbortController();
  private readonly pending: string[] = [];

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  submit(text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    this.pending.push(normalized);
    this.controller.abort();
  }

  drain(): string[] {
    const messages = this.pending.splice(0);
    if (this.controller.signal.aborted) {
      this.controller = new AbortController();
    }
    return messages;
  }

  reset(): void {
    this.pending.length = 0;
    if (this.controller.signal.aborted) {
      this.controller = new AbortController();
    }
  }
}

export async function appendGuidanceMessages(
  session: SessionStore,
  guidance?: AgentGuidance,
): Promise<boolean> {
  const messages = guidance?.drain() ?? [];
  for (const text of messages) {
    await session.append({ type: "user_message", text });
  }
  return messages.length > 0;
}

export async function refreshContextAfterGuidance(
  guidance: AgentGuidance | undefined,
  session: SessionStore,
  context: ContextBuilder,
  toolSchemas: Array<Record<string, unknown>>,
): Promise<{
  events: SessionEvent[];
  messages: AgentMessage[];
  estimatedInputTokens: number;
} | null> {
  if (!(await appendGuidanceMessages(session, guidance))) {
    return null;
  }

  const events = await session.load();
  const messages = await context.build(events);
  return {
    events,
    messages,
    estimatedInputTokens: estimateTokens({ messages, tools: toolSchemas }),
  };
}
