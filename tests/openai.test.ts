import { describe, expect, it } from "vitest";
import { ModelRequestError } from "../src/model/base.js";
import { OpenAIModel } from "../src/model/openai.js";

describe("OpenAIModel", () => {
  it("sends tools as OpenAI function tools and returns function calls", async () => {
    let requestBody: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));

      return new Response(
        JSON.stringify({
          id: "resp_123",
          output: [
            {
              type: "function_call",
              call_id: "call_123",
              name: "Read",
              arguments: JSON.stringify({ file_path: "README.md" }),
            },
          ],
          usage: {
            input_tokens: 120,
            output_tokens: 18,
            input_tokens_details: { cached_tokens: 40 },
          },
        }),
        { status: 200 },
      );
    };

    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      apiStyle: "responses",
      fetchImpl,
    });

    const result = await model.complete({
      messages: [{ role: "user", content: "read README" }],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      ],
      maxOutputTokens: 321,
    });

    expect(requestBody).toMatchObject({
      model: "test-model",
      stream: true,
      max_output_tokens: 321,
      input: [{ role: "user", content: "read README" }],
      tools: [
        {
          type: "function",
          name: "Read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      ],
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call_123",
        name: "Read",
        args: { file_path: "README.md" },
      },
    ]);
    expect(result).toMatchObject({
      requestId: "resp_123",
      usage: {
        inputTokens: 120,
        outputTokens: 18,
        cacheReadTokens: 40,
      },
    });
  });

  it("sends prior tool results back as function_call_output items", async () => {
    let requestBody: { input?: unknown[] } | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as { input?: unknown[] };

      return new Response(
        JSON.stringify({
          output_text: "done",
        }),
        { status: 200 },
      );
    };

    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    });

    const result = await model.complete({
      messages: [
        { role: "user", content: "read README" },
        {
          role: "assistant",
          content: "Assistant requested tool calls",
          toolCalls: [
            {
              id: "call_123",
              name: "Read",
              args: { file_path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          content: "Tool Read result: hello",
          toolResult: {
            toolCallId: "call_123",
            name: "Read",
            ok: true,
            content: "hello",
          },
        },
      ],
      tools: [],
    });

    expect(requestBody?.input).toContainEqual({
      type: "function_call",
      call_id: "call_123",
      name: "Read",
      arguments: JSON.stringify({ file_path: "README.md" }),
    });
    expect(requestBody?.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_123",
      output: "Tool Read result: hello",
    });
    expect(result.finalText).toBe("done");
  });

  it("does not treat content-filtered Responses output as max_tokens", async () => {
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            output_text: "partial",
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
          }),
          { status: 200 },
        ),
    });

    await expect(
      model.complete({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).resolves.toMatchObject({
      finalText: "partial",
      stopReason: "content_filter",
    });
  });

  it("uses a custom base URL and trims trailing slashes", async () => {
    let requestUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      requestUrl = String(input);

      return new Response(JSON.stringify({ output_text: "done" }), {
        status: 200,
      });
    };

    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://gateway.example/v1/",
      apiStyle: "responses",
      fetchImpl,
    });

    await model.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(requestUrl).toBe("https://gateway.example/v1/responses");
  });

  it("keeps compatibility safeguards for third-party chat APIs", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "compatible-model",
      baseUrl: "https://compatible.example/v1",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-compatible",
            choices: [
              {
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const result = await model.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object" },
        },
      ],
      maxOutputTokens: 100_000,
    });

    expect(requestUrl).toBe("https://compatible.example/v1/chat/completions");
    expect(requestBody).toMatchObject({
      model: "compatible-model",
      tool_choice: "auto",
      stream: true,
    });
    expect(requestBody).not.toHaveProperty("max_tokens");
    expect(result).toMatchObject({
      finalText: "ok",
      stopReason: "end_turn",
    });
  });

  it("sends supported max_tokens values to compatible APIs", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "compatible-model",
      baseUrl: "https://compatible.example/v1",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await model.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxOutputTokens: 4_096,
    });

    expect(requestBody).toMatchObject({ max_tokens: 4_096 });
  });

  it("rejects remote plaintext Base URLs but permits explicit localhost HTTP", () => {
    expect(
      () =>
        new OpenAIModel({
          apiKey: "test-key",
          model: "test-model",
          baseUrl: "http://gateway.example/v1",
        }),
    ).toThrow("must use HTTPS");

    expect(
      () =>
        new OpenAIModel({
          apiKey: "test-key",
          model: "test-model",
          baseUrl: "http://localhost:11434/v1",
        }),
    ).not.toThrow();
  });

  it("passes the task AbortSignal to fetch", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal;
      return new Response(JSON.stringify({ output_text: "done" }), {
        status: 200,
      });
    };
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    });

    await model.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      signal: controller.signal,
    });

    expect(requestSignal).toBe(controller.signal);
  });

  it("classifies retryable HTTP errors and honors Retry-After", async () => {
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { message: "rate limited" } }),
          {
            status: 429,
            headers: { "retry-after": "1.5" },
          },
        ),
    });

    const error = await model
      .complete({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error).toMatchObject({
      retryable: true,
      status: 429,
      retryAfterMs: 1_500,
    });
  });

  it("does not classify ordinary client errors as retryable", async () => {
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { message: "bad request" } }),
          { status: 400 },
        ),
    });

    await expect(
      model.complete({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).rejects.toMatchObject({
      retryable: false,
      status: 400,
    });
  });

  it("rejects oversized JSON responses before buffering the body", async () => {
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(17 * 1024 * 1024) },
        }),
    });

    await expect(
      model.complete({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).rejects.toThrow("16 MiB safety limit");
  });

  it("streams text deltas while returning the complete text", async () => {
    const deltas: string[] = [];
    const fetchImpl: typeof fetch = async () =>
      sseResponse(
        [
          {
            type: "response.output_text.delta",
            delta: "Hello",
          },
          {
            type: "response.output_text.delta",
            delta: " world",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_stream",
              output: [],
              usage: {
                input_tokens: 10,
                output_tokens: 2,
              },
            },
          },
        ],
        7,
      );
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    });

    const result = await model.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["Hello", " world"]);
    expect(result.finalText).toBe("Hello world");
    expect(result).toMatchObject({
      requestId: "resp_stream",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it("maps a streamed incomplete response to max_tokens", async () => {
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        {
          type: "response.output_text.delta",
          delta: "partial",
        },
        {
          type: "response.incomplete",
          response: {
            id: "resp_incomplete",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
            },
          },
        },
      ]);
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    });

    await expect(
      model.complete({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).resolves.toMatchObject({
      finalText: "partial",
      stopReason: "max_tokens",
      requestId: "resp_incomplete",
    });
  });

  it("assembles streamed function call arguments", async () => {
    const streamEvents: unknown[] = [];
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_streamed",
            name: "Read",
            arguments: '{"file_path":"README.md"}',
          },
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          name: "Read",
          arguments: '{"file_path":"README.md"}',
        },
      ]);
    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    });

    const result = await model.complete({
      messages: [{ role: "user", content: "read README" }],
      tools: [],
      onStreamEvent: (event) => streamEvents.push(event),
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_streamed",
        name: "Read",
        args: { file_path: "README.md" },
      },
    ]);
    expect(streamEvents).toContainEqual({
      type: "tool_call_args_delta",
      toolCallId: "call_streamed",
      delta: '{"file_path":"README.md"}',
    });
  });
});

function sseResponse(events: unknown[], chunkSize?: number): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const responseBody = chunkSize
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();

          for (let index = 0; index < body.length; index += chunkSize) {
            controller.enqueue(encoder.encode(body.slice(index, index + chunkSize)));
          }

          controller.close();
        },
      })
    : body;

  return new Response(responseBody, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
