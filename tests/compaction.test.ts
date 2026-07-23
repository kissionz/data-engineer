import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSessionSummary,
  estimateSessionEventTokens,
  getCompactionStats,
  SessionCompactor,
} from "../src/agent/compaction.js";
import { SessionStore } from "../src/agent/session.js";
import type { SessionEvent } from "../src/protocol.js";

describe("SessionCompactor", () => {
  it("reports an empty context as zero tokens", () => {
    expect(estimateSessionEventTokens([])).toBe(0);
  });

  it("appends a factual summary without deleting source events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-compact-"));
    const filePath = path.join(root, "session.jsonl");
    const store = new SessionStore(filePath);
    await store.append({ type: "user_message", text: "Fix the parser" });
    await store.append({
      type: "assistant_tool_calls",
      toolCalls: [
        {
          id: "call-1",
          name: "Edit",
          args: { file_path: "src/parser.ts" },
        },
      ],
    });
    await store.append({
      type: "tool_result",
      toolCallId: "call-1",
      name: "Edit",
      ok: true,
      content: "edited",
    });

    await expect(new SessionCompactor(store, 3).compactIfNeeded()).resolves.toBe(
      true,
    );

    const events = await store.load();
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      text: expect.stringContaining("src/parser.ts"),
    });
    expect((await readFile(filePath, "utf8")).split("\n").filter(Boolean)).toHaveLength(
      4,
    );
  });

  it("builds bounded sections from session facts", () => {
    const events: SessionEvent[] = [
      { type: "user_message", ts: "1", text: "Inspect the project" },
      {
        type: "assistant_tool_calls",
        ts: "2",
        toolCalls: [
          {
            id: "call-1",
            name: "Read",
            args: { file_path: "README.md" },
          },
          {
            id: "call-2",
            name: "Bash",
            args: { command: "npm test" },
          },
        ],
      },
      {
        type: "tool_result",
        ts: "3",
        toolCallId: "call-2",
        name: "Bash",
        ok: false,
        content: "test failed",
      },
    ];

    const summary = buildSessionSummary(events);

    expect(summary).toContain("Inspect the project");
    expect(summary).toContain("README.md");
    expect(summary).toContain("npm test");
    expect(summary).toContain("Bash: test failed");
    expect(summary).toContain("## Current User Request");
    expect(summary).not.toContain("## Active Constraints and Decisions");
  });

  it("keeps the current request distinct from deduplicated earlier requests", () => {
    const events: SessionEvent[] = [
      { type: "user_message", ts: "1", text: "Keep the interface simple" },
      { type: "user_message", ts: "2", text: "Keep the interface simple" },
      { type: "user_message", ts: "3", text: "Fix context compaction" },
    ];

    const summary = buildSessionSummary(events);
    const earlier = summary
      .split("## Earlier User Requests")[1]
      ?.split("## Todo State")[0];

    expect(summary).toContain("## Current User Request\nFix context compaction");
    expect(earlier).toContain("- Keep the interface simple");
    expect(earlier?.match(/Keep the interface simple/g)).toHaveLength(1);
    expect(earlier).not.toContain("Fix context compaction");
  });

  it("reports active context separately from durable stored events", () => {
    const events: SessionEvent[] = [
      { type: "user_message", ts: "1", text: "old" },
      { type: "summary", ts: "2", text: "summary" },
      { type: "user_message", ts: "3", text: "current" },
    ];

    expect(getCompactionStats(events)).toMatchObject({
      storedEvents: 3,
      activeEvents: 2,
      uncompactedEvents: 1,
      lastCompactedAt: "2",
    });
    expect(getCompactionStats(events).estimatedActiveTokens).toBeGreaterThan(0);
  });

  it("compacts when estimated context tokens cross the threshold", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-compact-"));
    const store = new SessionStore(path.join(root, "session.jsonl"));
    await store.append({
      type: "user_message",
      text: "x".repeat(400),
    });
    const events = await store.load();

    expect(estimateSessionEventTokens(events)).toBeGreaterThan(50);
    await expect(
      new SessionCompactor(store, 100, 50).compactIfNeeded({ events }),
    ).resolves.toBe(true);
    expect((await store.load()).at(-1)).toMatchObject({ type: "summary" });
  });

  it("can disable event-count compaction and rely on tokens only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-compact-"));
    const store = new SessionStore(path.join(root, "session.jsonl"));
    const events = Array.from(
      { length: 80 },
      (_, index): SessionEvent => ({
        type: "user_message",
        ts: String(index),
        text: "short",
      }),
    );

    await expect(
      new SessionCompactor(store, null, 1_000_000).compactIfNeeded({ events }),
    ).resolves.toBe(false);
  });
});
