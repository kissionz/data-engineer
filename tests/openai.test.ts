import { describe, expect, it } from "vitest";
import { OpenAIModel } from "../src/model/openai.js";

describe("OpenAIModel", () => {
  it("sends tools as OpenAI function tools and returns function calls", async () => {
    let requestBody: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              call_id: "call_123",
              name: "Read",
              arguments: JSON.stringify({ file_path: "README.md" }),
            },
          ],
        }),
        { status: 200 },
      );
    };

    const model = new OpenAIModel({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://example.test/v1",
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
    });

    expect(requestBody).toMatchObject({
      model: "test-model",
      stream: true,
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
      fetchImpl,
    });

    await model.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(requestUrl).toBe("https://gateway.example/v1/responses");
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
            response: { output: [] },
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
  });

  it("assembles streamed function call arguments", async () => {
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_streamed",
            name: "Read",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"file_path":',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '"README.md"}',
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
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_streamed",
        name: "Read",
        args: { file_path: "README.md" },
      },
    ]);
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
