import type { AgentMessage, AgentResponse, ToolCall } from "../agent/types.js";
import type { ModelClient } from "./base.js";

export interface OpenAIModelOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
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
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIModelOptions) {
    if (!options.apiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI model.");
    }

    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    onTextDelta?: (delta: string) => void;
  }): Promise<AgentResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        input: toOpenAIInput(options.messages),
        tools: options.tools.map(toOpenAITool),
        stream: true,
      }),
    });

    if (!response.ok) {
      const body = await readJsonResponse(response);
      const message =
        body?.error?.message ??
        `OpenAI API request failed with status ${response.status}`;
      throw new Error(message);
    }

    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return parseStreamingResponse(response, options.onTextDelta);
    }

    const body = await readJsonResponse(response);

    if (!body) {
      throw new Error("OpenAI API returned an empty or invalid JSON response.");
    }

    return parseResponseBody(body);
  }
}

async function parseStreamingResponse(
  response: Response,
  onTextDelta?: (delta: string) => void,
): Promise<AgentResponse> {
  if (!response.body) {
    throw new Error("OpenAI streaming response did not include a body.");
  }

  let finalBody: OpenAIResponseBody | undefined;
  let finalText = "";
  const streamedTools = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const event of parseServerSentEvents(response.body)) {
    if (event.type === "response.output_text.delta" && event.delta) {
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
        arguments: event.item.arguments ?? "",
      });
      continue;
    }

    if (
      event.type === "response.function_call_arguments.delta" &&
      typeof event.output_index === "number"
    ) {
      const tool = streamedTools.get(event.output_index);

      if (tool) {
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
        tool.arguments = event.arguments ?? tool.arguments;
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
        arguments: event.item.arguments ?? "",
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
    return { toolCalls };
  }

  const completedText = finalText || parseFinalText(finalBody ?? {});

  if (completedText) {
    return { finalText: completedText };
  }

  return {
    finalText: "OpenAI returned no final text or tool calls.",
  };
}

async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAIStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");

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
  return (await response.json().catch(() => null)) as OpenAIResponseBody | null;
}

function parseResponseBody(body: OpenAIResponseBody): AgentResponse {
  const toolCalls = parseToolCalls(body);

  if (toolCalls.length > 0) {
    return { toolCalls };
  }

  const finalText = parseFinalText(body);

  if (finalText) {
    return { finalText };
  }

  return {
    finalText: "OpenAI returned no final text or tool calls.",
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
  return value.replace(/\/+$/, "");
}
