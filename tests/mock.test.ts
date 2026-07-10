import { describe, expect, it, vi } from "vitest";
import { MockModel } from "../src/model/mock.js";

describe("MockModel", () => {
  it("runs a deterministic Read turn and reports a successful result honestly", async () => {
    const model = new MockModel("README.md");
    const first = await model.complete({ messages: [], tools: [] });
    expect(first.toolCalls?.[0]).toMatchObject({
      name: "Read",
      args: { file_path: "README.md" },
    });

    const onTextDelta = vi.fn();
    const second = await model.complete({
      messages: [
        {
          role: "tool",
          content: "ok",
          toolResult: {
            toolCallId: "call_1",
            name: "Read",
            ok: true,
            content: "README",
          },
        },
      ],
      tools: [],
      onTextDelta,
    });

    expect(second.finalText).toContain("successful Read");
    expect(onTextDelta).toHaveBeenCalledWith(second.finalText);
  });

  it("does not claim that a failed scripted Read succeeded", async () => {
    const model = new MockModel();
    await model.complete({ messages: [], tools: [] });
    const result = await model.complete({ messages: [], tools: [] });
    expect(result.finalText).toContain("failed as expected");
  });
});
