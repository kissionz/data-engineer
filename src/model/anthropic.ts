import type { AgentMessage, AgentResponse, StopReason } from "../agent/types.js";
import {
  ModelRequestError,
  type ModelCapabilities,
  type ModelClient,
  type ModelPricing,
} from "./base.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface AnthropicBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  id?: string;
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

export interface AnthropicModelOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  pricing?: ModelPricing;
  capabilities?: Partial<ModelCapabilities>;
  fetchImpl?: typeof fetch;
}

export class AnthropicModel implements ModelClient {
  readonly capabilities: Partial<ModelCapabilities>;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicModelOptions) {
    if (!options.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for the Anthropic model.");
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.anthropic.com/v1");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.capabilities = {
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      supportsStreaming: false,
      supportsToolUse: true,
      supportsImages: false,
      ...options.capabilities,
    };
  }

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
    onTextDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<AgentResponse> {
    const { system, messages } = toAnthropicMessages(options.messages);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: Math.min(options.maxOutputTokens ?? 8_192, 64_000),
          system,
          messages,
          tools: options.tools,
        }),
        signal: options.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw new ModelRequestError(
        error instanceof Error ? error.message : "Anthropic request failed.",
        true,
      );
    }
    const body = await readBoundedJson<AnthropicResponse>(response);
    if (!response.ok) {
      throw new ModelRequestError(
        body.error?.message ?? `Anthropic API failed with status ${response.status}.`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
        retryAfterMs(response.headers.get("retry-after")),
      );
    }
    const blocks = body.content ?? [];
    const finalText = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (finalText) {
      options.onTextDelta?.(finalText);
    }
    const toolCalls = blocks
      .filter((block) => block.type === "tool_use")
      .map((block, index) => ({
        id: requiredString(block.id, `anthropic_tool_${index + 1}`),
        name: requiredString(block.name, "Anthropic tool call missing name."),
        args: objectArgs(block.input),
      }));
    const usage = body.usage
      ? {
          inputTokens: body.usage.input_tokens ?? 0,
          outputTokens: body.usage.output_tokens ?? 0,
          ...(body.usage.cache_read_input_tokens !== undefined
            ? { cacheReadTokens: body.usage.cache_read_input_tokens }
            : {}),
        }
      : undefined;
    return {
      ...(finalText ? { finalText } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: mapStopReason(body.stop_reason),
      ...(usage ? { usage: applyPricing(usage, this.options.pricing) } : {}),
      ...(body.id ? { requestId: body.id } : {}),
    };
  }
}

function toAnthropicMessages(messages: AgentMessage[]): {
  system: string;
  messages: Array<Record<string, unknown>>;
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const converted: Array<Record<string, unknown>> = [];
  for (const message of messages.filter((item) => item.role !== "system")) {
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      converted.push({ role: "assistant", content });
    } else if (message.role === "tool" && message.toolResult) {
      converted.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolResult.toolCallId,
          content: message.toolResult.content,
          is_error: !message.toolResult.ok,
        }],
      });
    } else {
      converted.push({ role: "user", content: message.content });
    }
  }
  return { system, messages: converted };
}

async function readBoundedJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("Anthropic response exceeded the 16 MiB safety limit.");
  }
  return JSON.parse(text) as T;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Anthropic base URL must use HTTPS unless it is localhost.");
  }
  return url.toString().replace(/\/$/, "");
}

function requiredString(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mapStopReason(value: string | undefined): StopReason {
  if (value === "tool_use") return "tool_use";
  if (value === "max_tokens") return "max_tokens";
  if (value === "end_turn" || value === "stop_sequence") return "end_turn";
  return "unknown";
}

function retryAfterMs(value: string | null): number | undefined {
  const seconds = value === null ? NaN : Number(value);
  return Number.isFinite(seconds) ? Math.min(30_000, Math.max(0, seconds * 1_000)) : undefined;
}

function applyPricing(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
  pricing: ModelPricing | undefined,
) {
  if (!pricing) return usage;
  const cached = usage.cacheReadTokens ?? 0;
  return {
    ...usage,
    estimatedCostUsd:
      ((usage.inputTokens - cached) * pricing.inputPerMillionTokens +
        cached * (pricing.cacheReadPerMillionTokens ?? pricing.inputPerMillionTokens) +
        usage.outputTokens * pricing.outputPerMillionTokens) /
      1_000_000,
  };
}
