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
});
