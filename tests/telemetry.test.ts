import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../src/agent/types.js";
import {
  flushSessionTelemetryObservers,
  JsonlTelemetrySink,
  SessionTelemetryObserver,
  type TelemetryEvent,
  type TelemetrySink,
} from "../src/telemetry/index.js";

describe("telemetry lifecycle and storage", () => {
  it("emits task start before model events and supports disposal", async () => {
    const events: TelemetryEvent[] = [];
    const sink = memorySink(events);
    const observer = new SessionTelemetryObserver(sink, {
      provider: "openai",
      model: "test-model",
    });

    await observer.observe(sessionEvent(1, {
      type: "user_message",
      text: "secret task text",
    }));
    await observer.observe(sessionEvent(2, {
      type: "model_request_started",
    }));
    await observer.dispose();
    await flushSessionTelemetryObservers();

    expect(events.map((event) => event.type)).toEqual([
      "task_started",
      "model_request_started",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret task text");
  });

  it.runIf(process.platform !== "win32")(
    "keeps telemetry directories private and rejects hard-linked logs",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-telemetry-"));
      const directory = path.join(root, "events");
      const sink = new JsonlTelemetrySink(directory);
      await sink.emit(taskStarted());

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(sink.filePath)).mode & 0o777).toBe(0o600);

      const linkedDirectory = path.join(root, "linked");
      await mkdir(linkedDirectory, { mode: 0o700 });
      const source = path.join(root, "source.jsonl");
      await writeFile(source, "", { mode: 0o600 });
      await link(source, path.join(linkedDirectory, "telemetry.jsonl"));
      const failures: string[] = [];
      const linkedSink = new JsonlTelemetrySink(linkedDirectory, {
        onError: ({ operation }) => failures.push(operation),
      });
      await expect(linkedSink.emit(taskStarted())).resolves.toBeUndefined();
      expect(failures).toContain("prepare");
      expect(await readFile(source, "utf8")).toBe("");
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails open when the telemetry directory is a symlink",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-telemetry-"));
      const target = path.join(root, "target");
      const linked = path.join(root, "linked");
      await mkdir(target, { mode: 0o777 });
      await chmod(target, 0o777);
      await symlink(target, linked);
      const failures: string[] = [];
      const sink = new JsonlTelemetrySink(linked, {
        onError: ({ operation }) => failures.push(operation),
      });

      await expect(sink.emit(taskStarted())).resolves.toBeUndefined();
      expect(failures).toContain("prepare");
    },
  );
});

function memorySink(events: TelemetryEvent[]): TelemetrySink {
  return {
    emit: async (event) => {
      events.push(event);
    },
    flush: async () => undefined,
    close: async () => undefined,
  };
}

function sessionEvent(
  sequence: number,
  event:
    | { type: "user_message"; text: string }
    | { type: "model_request_started" },
): SessionEvent {
  const timestamp = new Date(sequence * 1_000).toISOString();
  return {
    ...event,
    eventId: `event-${sequence}`,
    sequence,
    sessionId: "session-1",
    timestamp,
    ts: timestamp,
  };
}

function taskStarted(): TelemetryEvent {
  return {
    type: "task_started",
    taskId: "task-1",
    sessionId: "session-1",
    trigger: "user",
  };
}
