import type { AgentMessage, AgentResponse, StopReason } from "../protocol.js";
import {
  ModelRequestError,
  type ModelCapabilities,
  type ModelClient,
  type ModelPricing,
} from "./base.js";

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string; code?: number };
}

export interface GeminiModelOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  pricing?: ModelPricing;
  capabilities?: Partial<ModelCapabilities>;
  fetchImpl?: typeof fetch;
}

export class GeminiModel implements ModelClient {
  readonly capabilities: Partial<ModelCapabilities>;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GeminiModelOptions) {
    if (!options.apiKey) throw new Error("GEMINI_API_KEY is required for Gemini.");
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.capabilities = {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
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
    const converted = toGeminiContents(options.messages);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/models/${encodeURIComponent(this.options.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.options.apiKey,
          },
          body: JSON.stringify({
            contents: converted.contents,
            ...(converted.systemInstruction
              ? { systemInstruction: converted.systemInstruction }
              : {}),
            ...(options.tools.length > 0
              ? { tools: [{ functionDeclarations: options.tools.map(toFunctionDeclaration) }] }
              : {}),
            generationConfig: {
              maxOutputTokens: Math.min(options.maxOutputTokens ?? 8_192, 65_536),
            },
          }),
          signal: options.signal,
        },
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ModelRequestError(
        error instanceof Error ? error.message : "Gemini request failed.",
        true,
      );
    }
    const body = await readJson<GeminiResponse>(response);
    if (!response.ok) {
      throw new ModelRequestError(
        body.error?.message ?? `Gemini API failed with status ${response.status}.`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const candidate = body.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const finalText = parts.map((part) => part.text ?? "").join("");
    if (finalText) options.onTextDelta?.(finalText);
    const toolCalls = parts
      .filter((part) => part.functionCall)
      .map((part, index) => ({
        id: part.functionCall?.id ?? `gemini_call_${index + 1}`,
        name: part.functionCall?.name ?? "unknown_tool",
        args: objectArgs(part.functionCall?.args),
      }));
    const metadata = body.usageMetadata;
    const usage = metadata
      ? applyPricing({
          inputTokens: metadata.promptTokenCount ?? 0,
          outputTokens: metadata.candidatesTokenCount ?? 0,
          ...(metadata.cachedContentTokenCount !== undefined
            ? { cacheReadTokens: metadata.cachedContentTokenCount }
            : {}),
        }, this.options.pricing)
      : undefined;
    return {
      ...(finalText ? { finalText } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      stopReason: toolCalls.length ? "tool_use" : mapFinishReason(candidate?.finishReason),
      ...(usage ? { usage } : {}),
    };
  }
}

function toGeminiContents(messages: AgentMessage[]) {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool" && message.toolResult) {
        return {
          role: "user",
          parts: [{
            functionResponse: {
              id: message.toolResult.toolCallId,
              name: message.toolResult.name,
              response: {
                output: message.toolResult.content,
                ok: message.toolResult.ok,
              },
            },
          }],
        };
      }
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { id: call.id, name: call.name, args: call.args } });
      }
      return { role: message.role === "assistant" ? "model" : "user", parts };
    });
  return {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
  };
}

function toFunctionDeclaration(schema: Record<string, unknown>) {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.input_schema,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) {
    throw new Error("Gemini response exceeded the 16 MiB safety limit.");
  }
  return JSON.parse(text) as T;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Gemini base URL must use HTTPS unless it is localhost.");
  }
  return url.toString().replace(/\/$/, "");
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mapFinishReason(value: string | undefined): StopReason {
  if (value === "STOP") return "end_turn";
  if (value === "MAX_TOKENS") return "max_tokens";
  if (value === "SAFETY" || value === "RECITATION") return "content_filter";
  return "unknown";
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
