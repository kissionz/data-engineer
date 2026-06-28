import type { AgentMessage, AgentResponse } from "../agent/types.js";
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

    _options.onTextDelta?.("Done.");
    return { finalText: "Done.", stopReason: "end_turn" };
  }
}
