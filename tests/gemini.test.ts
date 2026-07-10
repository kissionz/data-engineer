import { describe, expect, it } from "vitest";
import { GeminiModel } from "../src/model/gemini.js";

describe("GeminiModel", () => {
  it("uses native generateContent declarations and parses function calls", async () => {
    let request: Record<string, unknown> | undefined;
    let url = "";
    const model = new GeminiModel({
      apiKey: "test-key",
      model: "gemini-test",
      fetchImpl: async (input, init) => {
        url = String(input);
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          candidates: [{
            content: { parts: [
              { text: "Checking." },
              { functionCall: { id: "call-1", name: "Read", args: { file_path: "README.md" } } },
            ] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
        }));
      },
    });
    const result = await model.complete({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "read" },
      ],
      tools: [{ name: "Read", description: "Read", input_schema: { type: "object" } }],
    });
    expect(url).toContain("gemini-test:generateContent");
    expect(request).toMatchObject({
      systemInstruction: { parts: [{ text: "system" }] },
      tools: [{ functionDeclarations: [{ name: "Read", parameters: { type: "object" } }] }],
    });
    expect(result).toMatchObject({
      finalText: "Checking.",
      stopReason: "tool_use",
      toolCalls: [{ id: "call-1", name: "Read", args: { file_path: "README.md" } }],
    });
  });

  it("maps function responses back with the original call id", async () => {
    let body = "";
    const model = new GeminiModel({
      apiKey: "test-key",
      model: "gemini-test",
      fetchImpl: async (_input, init) => {
        body = String(init?.body);
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
        }));
      },
    });
    await model.complete({
      messages: [{
        role: "tool",
        content: "ok",
        toolResult: { toolCallId: "call-1", name: "Read", ok: true, content: "ok" },
      }],
      tools: [],
    });
    expect(body).toContain('"functionResponse":{"id":"call-1","name":"Read"');
  });
});
