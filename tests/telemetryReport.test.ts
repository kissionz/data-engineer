import {
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateTelemetry,
  readTelemetryReport,
} from "../src/telemetry/report.js";
import type { TelemetryEvent } from "../src/telemetry/types.js";

describe("offline telemetry report", () => {
  it("aggregates outcomes, usage, cost, tools, and cancellation without content", () => {
    const report = aggregateTelemetry([
      event({ type: "task_started", taskId: "task-1", trigger: "user" }),
      event({
        type: "model_request_started",
        taskId: "task-1",
        provider: "openai",
        model: "model",
        attempt: 1,
      }),
      event({
        type: "model_request_finished",
        taskId: "task-1",
        provider: "openai",
        model: "model",
        outcome: "succeeded",
        durationMs: 10,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        estimatedCostUsd: 0.25,
      }),
      event({
        type: "tool_started",
        taskId: "task-1",
        toolCallId: "call-1",
        toolName: "Read",
        effect: "readonly",
      }),
      event({
        type: "tool_finished",
        taskId: "task-1",
        toolCallId: "call-1",
        toolName: "Read",
        outcome: "succeeded",
        durationMs: 2,
      }),
      event({
        type: "cancellation_requested",
        taskId: "task-1",
        source: "user",
        phase: "model",
      }),
      event({
        type: "cancellation_finished",
        taskId: "task-1",
        phase: "model",
        durationMs: 1,
      }),
      event({
        type: "task_finished",
        taskId: "task-1",
        outcome: "succeeded",
        durationMs: 20,
      }),
    ]);

    expect(report).toMatchObject({
      eventCount: 8,
      tasks: { started: 1, finished: 1, succeeded: 1, successRate: 1 },
      models: {
        started: 1,
        finished: 1,
        succeeded: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        estimatedCostUsd: 0.25,
      },
      tools: { started: 1, finished: 1, succeeded: 1 },
      cancellations: {
        requested: 1,
        finished: 1,
        bySource: { user: 1 },
      },
    });
    expect(JSON.stringify(report)).not.toContain("task-1");
    expect(JSON.stringify(report)).not.toContain('"toolName":"Read"');
  });

  it("strictly reads canonical bounded JSONL", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telemetry-report-"));
    const filePath = path.join(root, "telemetry.jsonl");
    await writeFile(
      filePath,
      `${JSON.stringify(envelope(event({
        type: "task_finished",
        taskId: "task-1",
        outcome: "failed",
        durationMs: 5,
      })))}\n`,
      "utf8",
    );

    await expect(readTelemetryReport(filePath)).resolves.toMatchObject({
      eventCount: 1,
      tasks: { finished: 1, failed: 1, successRate: 0 },
    });
    await expect(
      readTelemetryReport(filePath, { maxBytes: 4 }),
    ).rejects.toThrow("exceeds 4 bytes");
  });

  it("rejects unknown fields, unterminated records, and symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telemetry-report-"));
    const filePath = path.join(root, "telemetry.jsonl");
    const invalid = envelope(event({
      type: "task_started",
      taskId: "task-1",
      trigger: "user",
    })) as Record<string, unknown>;
    invalid.content = "must never be accepted";
    await writeFile(filePath, `${JSON.stringify(invalid)}\n`, "utf8");
    await expect(readTelemetryReport(filePath)).rejects.toThrow(
      "envelope fields",
    );

    await writeFile(filePath, JSON.stringify(envelope(event({
      type: "task_started",
      taskId: "task-1",
      trigger: "user",
    }))), "utf8");
    await expect(readTelemetryReport(filePath)).rejects.toThrow(
      "unterminated final record",
    );

    const linked = path.join(root, "linked.jsonl");
    await symlink(filePath, linked);
    await expect(readTelemetryReport(linked)).rejects.toThrow("non-symlink");
  });
});

function event<T extends TelemetryEvent>(value: T): T {
  return value;
}

function envelope(eventValue: TelemetryEvent): unknown {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    timestamp: "2026-06-29T00:00:00.000Z",
    event: eventValue,
  };
}
