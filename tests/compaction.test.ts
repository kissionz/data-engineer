import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSessionSummary,
  estimateSessionEventTokens,
  SessionCompactor,
} from "../src/agent/compaction.js";
import { SessionStore } from "../src/agent/session.js";
import type { SessionEvent } from "../src/agent/types.js";

describe("SessionCompactor", () => {
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
});
