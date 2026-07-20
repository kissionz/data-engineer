import type { AgentMessage, AgentResponse } from "../protocol.js";
import type { ModelClient } from "./base.js";

export class MockModel implements ModelClient {
  private step = 0;

  constructor(private readonly filePath = "README.md") {}

  async complete(_options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    onTextDelta?: (delta: string) => void;
  }): Promise<AgentResponse> {
    this.step += 1;

    if (this.step === 1) {
      return {
        toolCalls: [
          {
            id: "call_1",
            name: "Read",
            args: { file_path: this.filePath },
          },
        ],
        stopReason: "tool_use",
      };
    }

    const toolResult = [..._options.messages]
      .reverse()
      .find((message) => message.role === "tool")?.toolResult;
    const finalText = toolResult?.ok
      ? "Mock loop completed after a successful Read call."
      : "Mock loop completed; the scripted Read call failed as expected in this workspace.";
    _options.onTextDelta?.(finalText);
    return { finalText, stopReason: "end_turn" };
  }
}
