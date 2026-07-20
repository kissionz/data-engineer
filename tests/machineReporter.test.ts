import { describe, expect, it } from "vitest";
import {
  MACHINE_OUTPUT_SCHEMA_VERSION,
  MachineReporter,
} from "../src/ui/machineReporter.js";

describe("MachineReporter", () => {
  it("emits one stable JSON result in json mode", () => {
    const output: string[] = [];
    const reporter = new MachineReporter("json", (text) => output.push(text));
    reporter.onTextDelta("done");
    reporter.onToolStatus(
      { id: "1", name: "Read", args: { file_path: "README.md" } },
      "succeeded",
      { ok: true, content: "secret content is not emitted" },
    );
    reporter.finish("session-1", "completed", "done", {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 1,
      estimatedCostUsd: 0.001,
    });
    expect(output).toHaveLength(1);
    const result = JSON.parse(output[0] ?? "") as Record<string, unknown>;
    expect(result).toMatchObject({
      type: "result",
      schemaVersion: 1,
      sessionId: "session-1",
      status: "completed",
      text: "done",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
      },
    });
    expect(output[0]).not.toContain("secret content");
  });

  it("streams deltas, bounded tool metadata, and a final result", () => {
    const output: string[] = [];
    const reporter = new MachineReporter("stream-json", (text) =>
      output.push(text),
    );
    reporter.onTextDelta("a");
    reporter.onTextEnd();
    reporter.onToolStatus(
      { id: "read-2", name: "Read", args: { file_path: "README.md" } },
      "running",
    );
    reporter.finish("session-2", "completed");
    expect(output.map((line) => JSON.parse(line).type)).toEqual([
      "text_delta",
      "text_end",
      "tool",
      "result",
    ]);
    expect(
      output.map((line) => JSON.parse(line).schemaVersion),
    ).toEqual([
      MACHINE_OUTPUT_SCHEMA_VERSION,
      MACHINE_OUTPUT_SCHEMA_VERSION,
      MACHINE_OUTPUT_SCHEMA_VERSION,
      MACHINE_OUTPUT_SCHEMA_VERSION,
    ]);
  });
});
