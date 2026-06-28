import type { AgentMessage, AgentResponse, ToolCall } from "../agent/types.js";
import { ModelRequestError, type ModelClient } from "./base.js";

const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_STREAM_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 1024 * 1024;

export type ApiStyle = "responses" | "chat_completions";

export interface OpenAIModelOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiStyle?: ApiStyle;
  fetchImpl?: typeof fetch;
}

type OpenAIInputItem =
  | {
      role: "system" | "user" | "assistant";
      content: string;
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

interface OpenAIResponseOutputItem {
  type?: string;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

interface OpenAIResponseBody {
  id?: string;
  output_text?: string;
  output?: OpenAIResponseOutputItem[];
  error?: {
    message?: string;
    type?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

interface OpenAIStreamEvent {
  type?: string;
  output_index?: number;
  delta?: string;
  arguments?: string;
  name?: string;
  call_id?: string;
  item?: OpenAIResponseOutputItem;
  response?: OpenAIResponseBody;
  error?: {
    message?: string;
  };
}

export class OpenAIModel implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiStyle: ApiStyle;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIModelOptions) {
    if (!options.apiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI model.");
    }

    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Auto-detect: use chat_completions for non-OpenAI endpoints
    this.apiStyle = options.apiStyle ?? inferApiStyle(this.baseUrl);
  }

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
    onTextDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<AgentResponse> {
    if (this.apiStyle === "chat_completions") {
      return this.completeChatCompletions(options);
    }
    return this.completeResponses(options);
  }

  private async completeResponses(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
    onTextDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<AgentResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          input: toOpenAIInput(options.messages),
          tools: options.tools.map(toOpenAITool),
          ...(options.maxOutputTokens !== undefined
            ? { max_output_tokens: options.maxOutputTokens }
            : {}),
          stream: true,
        }),
        signal: options.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw new ModelRequestError(
        error instanceof Error ? error.message : "Model network request failed.",
        true,
      );
    }

    if (!response.ok) {
      const body = await readJsonResponse(response);
      const message =
        body?.error?.message ??
        `OpenAI API request failed with status ${response.status}`;
      throw new ModelRequestError(
        message,
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return parseStreamingResponse(
        response,
        options.onTextDelta,
        options.maxOutputTokens,
      );
    }

    const body = await readJsonResponse(response);

    if (!body) {
      throw new Error("OpenAI API returned an empty or invalid JSON response.");
    }

    return parseResponseBody(body);
  }

  private async completeChatCompletions(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
    onTextDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<AgentResponse> {
    const chatMessages = toChatCompletionsMessages(options.messages);
    const chatTools = options.tools.map(toChatCompletionsTool);
    // Cap max_tokens for third-party APIs; most support at most 4096-32768 per request.
    // Don't send max_tokens if it exceeds a safe threshold — let the API use its own default.
    const safeMaxTokens =
      options.maxOutputTokens !== undefined && options.maxOutputTokens <= 32_768
        ? options.maxOutputTokens
        : undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: chatMessages,
          ...(chatTools.length > 0
            ? { tools: chatTools, tool_choice: "auto" }
            : {}),
          ...(safeMaxTokens !== undefined
            ? { max_tokens: safeMaxTokens }
            : {}),
          stream: true,
        }),
        signal: options.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw new ModelRequestError(
        error instanceof Error ? error.message : "Model network request failed.",
        true,
      );
    }

    if (!response.ok) {
      const body = await readChatJsonResponse(response);
      const message =
        body?.error?.message ??
        `API request failed with status ${response.status}`;
      throw new ModelRequestError(
        message,
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return parseChatStreamingResponse(
        response,
        options.onTextDelta,
        options.maxOutputTokens,
      );
    }

    const body = await readChatJsonResponse(response);
    if (!body) {
      throw new Error("API returned an empty or invalid JSON response.");
    }
    return parseChatResponseBody(body);
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, Math.round(seconds * 1_000));
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return Math.min(30_000, Math.max(0, timestamp - Date.now()));
}

async function parseStreamingResponse(
  response: Response,
  onTextDelta?: (delta: string) => void,
  maxOutputTokens?: number,
): Promise<AgentResponse> {
  if (!response.body) {
    throw new Error("OpenAI streaming response did not include a body.");
  }

  let finalBody: OpenAIResponseBody | undefined;
  let finalText = "";
  const maxTextChars = Math.min(
    16 * 1024 * 1024,
    Math.max(8_192, (maxOutputTokens ?? 250_000) * 8),
  );
  const streamedTools = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const event of parseServerSentEvents(response.body)) {
    if (event.type === "response.output_text.delta" && event.delta) {
      if (finalText.length + event.delta.length > maxTextChars) {
        throw new Error("OpenAI streamed text exceeded the safety limit.");
      }
      finalText += event.delta;
      onTextDelta?.(event.delta);
      continue;
    }

    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "function_call" &&
      typeof event.output_index === "number"
    ) {
      streamedTools.set(event.output_index, {
        id: event.item.call_id ?? event.item.id ?? `call_${event.output_index + 1}`,
        name: requiredString(
          event.item.name,
          "OpenAI streamed function call missing name.",
        ),
        arguments: boundedToolArguments(event.item.arguments ?? ""),
      });
      continue;
    }

    if (
      event.type === "response.function_call_arguments.delta" &&
      typeof event.output_index === "number"
    ) {
      const tool = streamedTools.get(event.output_index);

      if (tool) {
        if (
          tool.arguments.length + (event.delta?.length ?? 0) >
          MAX_TOOL_ARGUMENT_CHARS
        ) {
          throw new Error(
            "OpenAI streamed tool arguments exceeded the safety limit.",
          );
        }
        tool.arguments += event.delta ?? "";
      }
      continue;
    }

    if (
      event.type === "response.function_call_arguments.done" &&
      typeof event.output_index === "number"
    ) {
      const tool = streamedTools.get(event.output_index);

      if (tool) {
        tool.arguments = boundedToolArguments(
          event.arguments ?? tool.arguments,
        );
        tool.name = event.name ?? tool.name;
        tool.id = event.call_id ?? tool.id;
      }
      continue;
    }

    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "function_call" &&
      typeof event.output_index === "number"
    ) {
      streamedTools.set(event.output_index, {
        id: event.item.call_id ?? event.item.id ?? `call_${event.output_index + 1}`,
        name: requiredString(
          event.item.name,
          "OpenAI streamed function call missing name.",
        ),
        arguments: boundedToolArguments(event.item.arguments ?? ""),
      });
      continue;
    }

    if (event.type === "response.completed" && event.response) {
      finalBody = event.response;
      continue;
    }

    if (event.type === "response.failed" || event.type === "error") {
      const message =
        event.error?.message ??
        event.response?.error?.message ??
        "OpenAI streaming response failed.";
      throw new Error(message);
    }
  }

  const toolCalls =
    streamedTools.size > 0
      ? [...streamedTools.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, tool]) => ({
            id: tool.id,
            name: tool.name,
            args: parseArguments(tool.arguments),
          }))
      : parseToolCalls(finalBody ?? {});

  if (toolCalls.length > 0) {
    return {
      toolCalls,
      usage: parseUsage(finalBody),
      requestId: finalBody?.id,
    };
  }

  const completedText = finalText || parseFinalText(finalBody ?? {});

  if (completedText) {
    return {
      finalText: completedText,
      usage: parseUsage(finalBody),
      requestId: finalBody?.id,
    };
  }

  return {
    finalText: "OpenAI returned no final text or tool calls.",
    usage: parseUsage(finalBody),
    requestId: finalBody?.id,
  };
}

function boundedToolArguments(value: string): string {
  if (value.length > MAX_TOOL_ARGUMENT_CHARS) {
    throw new Error(
      "OpenAI streamed tool arguments exceeded the safety limit.",
    );
  }
  return value;
}

async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAIStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      receivedBytes += value?.byteLength ?? 0;
      if (receivedBytes > MAX_STREAM_BYTES) {
        throw new Error("OpenAI stream exceeded the 64 MiB safety limit.");
      }
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");
      if (
        buffer.length > MAX_STREAM_EVENT_BYTES &&
        !buffer.includes("\n\n")
      ) {
        throw new Error("OpenAI stream event exceeded the safety limit.");
      }

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventBlock(block);

        if (event) {
          yield event;
        }

        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > MAX_STREAM_EVENT_BYTES) {
        throw new Error("OpenAI stream event exceeded the safety limit.");
      }

      if (done) {
        const event = parseEventBlock(buffer);

        if (event) {
          yield event;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): OpenAIStreamEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data) as OpenAIStreamEvent;
  } catch {
    throw new Error("OpenAI returned an invalid streaming event.");
  }
}

async function readJsonResponse(
  response: Response,
): Promise<OpenAIResponseBody | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_JSON_RESPONSE_BYTES
  ) {
    throw new Error("OpenAI JSON response exceeded the 16 MiB safety limit.");
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_JSON_RESPONSE_BYTES) {
        throw new Error(
          "OpenAI JSON response exceeded the 16 MiB safety limit.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as OpenAIResponseBody;
  } catch {
    return null;
  }
}

function parseResponseBody(body: OpenAIResponseBody): AgentResponse {
  const toolCalls = parseToolCalls(body);

  if (toolCalls.length > 0) {
    return {
      toolCalls,
      usage: parseUsage(body),
      requestId: body.id,
    };
  }

  const finalText = parseFinalText(body);

  if (finalText) {
    return {
      finalText,
      usage: parseUsage(body),
      requestId: body.id,
    };
  }

  return {
    finalText: "OpenAI returned no final text or tool calls.",
    usage: parseUsage(body),
    requestId: body.id,
  };
}

function parseUsage(
  body: OpenAIResponseBody | undefined,
): AgentResponse["usage"] {
  const inputTokens = body?.usage?.input_tokens;
  const outputTokens = body?.usage?.output_tokens;

  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens ?? -1) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens ?? -1) < 0
  ) {
    return undefined;
  }

  const cacheReadTokens = body?.usage?.input_tokens_details?.cached_tokens;
  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    ...(Number.isSafeInteger(cacheReadTokens) && (cacheReadTokens ?? -1) >= 0
      ? { cacheReadTokens }
      : {}),
  };
}

function toOpenAIInput(messages: AgentMessage[]): OpenAIInputItem[] {
  const input: OpenAIInputItem[] = [];

  for (const message of messages) {
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        });
      }

      continue;
    }

    if (message.toolResult) {
      input.push({
        type: "function_call_output",
        call_id: message.toolResult.toolCallId,
        output: message.content,
      });
      continue;
    }

    if (message.role === "tool") {
      input.push({
        role: "user",
        content: message.content,
      });
      continue;
    }

    input.push({
      role: message.role,
      content: message.content,
    });
  }

  return input;
}

function toOpenAITool(tool: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  };
}

function parseToolCalls(body: OpenAIResponseBody): ToolCall[] {
  const output = body.output ?? [];

  return output
    .filter((item) => item.type === "function_call")
    .map((item, index) => ({
      id: item.call_id ?? item.id ?? `call_${index + 1}`,
      name: requiredString(item.name, "OpenAI function call missing name."),
      args: parseArguments(item.arguments),
    }));
}

function parseFinalText(body: OpenAIResponseBody): string | undefined {
  if (body.output_text) {
    return body.output_text;
  }

  const chunks: string[] = [];

  for (const item of body.output ?? []) {
    if (item.type !== "message") {
      continue;
    }

    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text) {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n").trim() || undefined;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(message);
  }

  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  throw new Error("OpenAI function call arguments must decode to an object.");
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const localhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.username || url.password || url.hash) {
    throw new Error("OpenAI Base URL cannot contain credentials or a fragment.");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && localhost)
  ) {
    throw new Error(
      "OpenAI Base URL must use HTTPS; HTTP is allowed only for localhost.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function inferApiStyle(baseUrl: string): ApiStyle {
  try {
    const url = new URL(baseUrl);
    if (
      url.hostname === "api.openai.com" ||
      url.hostname.endsWith(".openai.com")
    ) {
      return "responses";
    }
  } catch {
    // fall through
  }
  return "chat_completions";
}

// ─── Chat Completions types and helpers ───────────────────────────────────────

interface ChatCompletionsMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionsResponseBody {
  id?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
  };
}

function toChatCompletionsMessages(
  messages: AgentMessage[],
): ChatCompletionsMessage[] {
  const result: ChatCompletionsMessage[] = [];

  for (const msg of messages) {
    if (msg.toolCalls) {
      result.push({
        role: "assistant",
        content: null,
        tool_calls: msg.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        })),
      });
      continue;
    }

    if (msg.toolResult) {
      result.push({
        role: "tool",
        content: msg.content,
        tool_call_id: msg.toolResult.toolCallId,
      });
      continue;
    }

    if (msg.role === "tool") {
      result.push({ role: "user", content: msg.content });
      continue;
    }

    result.push({ role: msg.role, content: msg.content });
  }

  return result;
}

function toChatCompletionsTool(
  tool: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

async function readChatJsonResponse(
  response: Response,
): Promise<ChatCompletionsResponseBody | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_JSON_RESPONSE_BYTES
  ) {
    throw new Error("API JSON response exceeded the 16 MiB safety limit.");
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_JSON_RESPONSE_BYTES) {
        throw new Error("API JSON response exceeded the 16 MiB safety limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as ChatCompletionsResponseBody;
  } catch {
    return null;
  }
}

function parseChatResponseBody(
  body: ChatCompletionsResponseBody,
): AgentResponse {
  const choice = body.choices?.[0];
  if (!choice?.message) {
    return {
      finalText: "API returned no choices.",
      usage: parseChatUsage(body),
      requestId: body.id,
    };
  }

  const toolCalls = choice.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    return {
      toolCalls: toolCalls.map((tc, i) => ({
        id: tc.id ?? `call_${i + 1}`,
        name: requiredString(
          tc.function?.name,
          "Chat completions tool call missing function name.",
        ),
        args: parseArguments(tc.function?.arguments ?? ""),
      })),
      usage: parseChatUsage(body),
      requestId: body.id,
    };
  }

  const text = choice.message.content;
  return {
    finalText: text || "API returned no content.",
    usage: parseChatUsage(body),
    requestId: body.id,
  };
}

function parseChatUsage(
  body: ChatCompletionsResponseBody,
): AgentResponse["usage"] {
  const inputTokens = body.usage?.prompt_tokens;
  const outputTokens = body.usage?.completion_tokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens ?? -1) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens ?? -1) < 0
  ) {
    return undefined;
  }
  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
  };
}

async function parseChatStreamingResponse(
  response: Response,
  onTextDelta?: (delta: string) => void,
  maxOutputTokens?: number,
): Promise<AgentResponse> {
  if (!response.body) {
    throw new Error("Chat completions streaming response did not include a body.");
  }

  let finalText = "";
  const maxTextChars = Math.min(
    16 * 1024 * 1024,
    Math.max(8_192, (maxOutputTokens ?? 250_000) * 8),
  );
  const streamedTools = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let lastBody: ChatCompletionsResponseBody | undefined;

  for await (const event of parseChatSSEStream(response.body)) {
    lastBody = event;
    const choice = event.choices?.[0];
    if (!choice?.delta) continue;

    // Text content delta
    if (choice.delta.content) {
      if (finalText.length + choice.delta.content.length > maxTextChars) {
        throw new Error("Chat streaming text exceeded the safety limit.");
      }
      finalText += choice.delta.content;
      onTextDelta?.(choice.delta.content);
    }

    // Tool call deltas
    if (choice.delta.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        const existing = streamedTools.get(idx);
        if (!existing) {
          streamedTools.set(idx, {
            id: tc.id ?? `call_${idx + 1}`,
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          });
        } else {
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) {
            if (
              existing.arguments.length + tc.function.arguments.length >
              MAX_TOOL_ARGUMENT_CHARS
            ) {
              throw new Error(
                "Chat streaming tool arguments exceeded the safety limit.",
              );
            }
            existing.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  if (streamedTools.size > 0) {
    return {
      toolCalls: [...streamedTools.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tool]) => ({
          id: tool.id,
          name: requiredString(
            tool.name,
            "Chat streaming tool call missing function name.",
          ),
          args: parseArguments(tool.arguments),
        })),
      usage: lastBody ? parseChatUsage(lastBody) : undefined,
      requestId: lastBody?.id,
    };
  }

  if (finalText) {
    return {
      finalText,
      usage: lastBody ? parseChatUsage(lastBody) : undefined,
      requestId: lastBody?.id,
    };
  }

  return {
    finalText: "API returned no final text or tool calls.",
    usage: lastBody ? parseChatUsage(lastBody) : undefined,
    requestId: lastBody?.id,
  };
}

async function* parseChatSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatCompletionsResponseBody> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      receivedBytes += value?.byteLength ?? 0;
      if (receivedBytes > MAX_STREAM_BYTES) {
        throw new Error("Chat stream exceeded the 64 MiB safety limit.");
      }
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data) as ChatCompletionsResponseBody;
          } catch {
            throw new Error("API returned an invalid streaming event.");
          }
        }

        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        // Handle remaining buffer
        if (buffer.trim()) {
          const data = buffer
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") {
            try {
              yield JSON.parse(data) as ChatCompletionsResponseBody;
            } catch {
              // ignore trailing invalid data
            }
          }
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
