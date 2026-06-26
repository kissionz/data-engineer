import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../src/agent/context.js";
import type { SessionEvent } from "../src/agent/types.js";

describe("ContextBuilder", () => {
  it("loads neutral project instruction files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-context-"));
    await writeFile(path.join(root, "AGENTS.md"), "Use npm test.", "utf8");

    const messages = await new ContextBuilder(root).build([]);

    expect(messages).toContainEqual({
      role: "system",
      content: "Project instructions:\n\nUse npm test.",
    });
  });

  it("uses the latest summary and drops orphaned tool results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-context-"));
    const events: SessionEvent[] = [
      { type: "summary", ts: "1", text: "Earlier work is complete." },
      {
        type: "assistant_tool_calls",
        ts: "2",
        toolCalls: [
          { id: "call-1", name: "Read", args: { file_path: "a.txt" } },
        ],
      },
      {
        type: "tool_result",
        ts: "3",
        toolCallId: "call-1",
        name: "Read",
        ok: true,
        content: "a",
      },
      {
        type: "tool_result",
        ts: "4",
        toolCallId: "call-old",
        name: "Read",
        ok: true,
        content: "orphan",
      },
    ];

    const messages = await new ContextBuilder(root, 2).build(events);

    expect(messages).toContainEqual({
      role: "system",
      content: "Previous session summary:\n\nEarlier work is complete.",
    });
    expect(messages.some((message) => message.role === "tool")).toBe(false);
  });
});
