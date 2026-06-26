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

export class OpenAIModel implements ModelClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIModelOptions) {
    if (!options.apiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI model.");
    }

    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
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
      }),
    });

    const body = (await response.json().catch(() => null)) as OpenAIResponseBody | null;

    if (!response.ok) {
      const message =
        body?.error?.message ??
        `OpenAI API request failed with status ${response.status}`;
      throw new Error(message);
    }

    if (!body) {
      throw new Error("OpenAI API returned an empty or invalid JSON response.");
    }

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
