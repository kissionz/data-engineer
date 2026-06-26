import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../src/agent/context.js";

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
});
