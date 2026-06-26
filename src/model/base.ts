import type { AgentMessage, AgentResponse } from "../agent/types.js";

export interface ModelClient {
  complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
  }): Promise<AgentResponse>;
}
