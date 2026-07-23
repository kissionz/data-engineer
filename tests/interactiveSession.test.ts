import { describe, expect, it } from "vitest";
import type { SessionMetadata } from "../src/agent/sessionManager.js";
import type { SessionEvent } from "../src/protocol.js";
import {
  formatContext,
  formatHelp,
  formatSessionList,
  formatSessionMetadata,
  formatWelcome,
} from "../src/cli/interactiveSession.js";

const metadata: SessionMetadata = {
  id: "20260723-120000-abcdef",
  title: "Parser cleanup",
  workspaceRoot: "/workspace/project",
  model: "gpt-test",
  createdAt: "2026-07-23T12:00:00.000Z",
  updatedAt: "2026-07-23T12:30:00.000Z",
  status: "running",
  lastSequence: 12,
};

describe("interactive session presentation", () => {
  it("starts with a compact orientation instead of dumping every command", () => {
    const welcome = formatWelcome(metadata, "default");

    expect(welcome).toContain("Montane Code · gpt-test");
    expect(welcome).toContain("Parser cleanup · running");
    expect(welcome).toContain("/help for commands");
    expect(welcome).not.toContain("/sessions");
  });

  it("groups help by user intent", () => {
    const help = formatHelp();

    expect(help).toContain("Sessions   /new");
    expect(help).toContain("Context    /context");
    expect(help).toContain("While Montane is working");
  });

  it("formats session metadata and marks the active session", () => {
    const details = formatSessionMetadata(metadata);
    const list = formatSessionList(
      [
        metadata,
        {
          ...metadata,
          id: "20260723-130000-fedcba",
          title: undefined,
          status: "completed",
        },
      ],
      metadata.id,
    );

    expect(details).toContain("Workspace  /workspace/project");
    expect(list).toContain("● Parser cleanup · running · gpt-test");
    expect(list).toContain("fedcba · completed · gpt-test");
    expect(list).not.toContain("\t");
  });

  it("separates active context from durable history", () => {
    const events: SessionEvent[] = [
      { type: "user_message", ts: "1", text: "old" },
      { type: "summary", ts: "2", text: "summary" },
      { type: "user_message", ts: "3", text: "current" },
    ];

    const context = formatContext(events);

    expect(context).toContain("Active     2 events");
    expect(context).toContain("Stored     3 events");
    expect(context).toContain("Compacted");
  });
});
