import { describe, expect, it } from "vitest";
import { AnthropicModel } from "../src/model/anthropic.js";
import { ModelRequestError } from "../src/model/base.js";

describe("AnthropicModel", () => {
  it("uses native Messages tool blocks and parses tool use", async () => {
    let request: Record<string, unknown> | undefined;
    const model = new AnthropicModel({
      apiKey: "test-key",
      model: "claude-test",
      fetchImpl: async (_input, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "msg_1",
            content: [
              { type: "text", text: "Checking." },
              { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    });
    const result = await model.complete({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "read" },
      ],
      tools: [{ name: "Read", description: "Read", input_schema: { type: "object" } }],
    });
    expect(request).toMatchObject({
      model: "claude-test",
      system: "system",
      messages: [{ role: "user", content: "read" }],
    });
    expect(result).toMatchObject({
      finalText: "Checking.",
      stopReason: "tool_use",
      toolCalls: [{ id: "toolu_1", name: "Read", args: { file_path: "README.md" } }],
    });
  });

  it("returns native tool results and classifies transient failures", async () => {
    let request: Record<string, unknown> | undefined;
    const model = new AnthropicModel({
      apiKey: "test-key",
      model: "claude-test",
      fetchImpl: async (_input, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }));
      },
    });
    await model.complete({
      messages: [{
        role: "tool",
        content: "failed",
        toolResult: { toolCallId: "toolu_1", name: "Read", ok: false, content: "failed" },
      }],
      tools: [],
    });
    expect(JSON.stringify(request)).toContain('"is_error":true');

    const failing = new AnthropicModel({
      apiKey: "test-key",
      model: "claude-test",
      fetchImpl: async () => new Response(
        JSON.stringify({ error: { message: "overloaded" } }),
        { status: 529 },
      ),
    });
    await expect(failing.complete({ messages: [], tools: [] })).rejects.toMatchObject({
      constructor: ModelRequestError,
      retryable: true,
      status: 529,
    });
  });
});
