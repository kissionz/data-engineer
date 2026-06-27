import {
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/agent/session.js";

describe("SessionStore", () => {
  it("ignores only a malformed unterminated final JSONL fragment", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "session.jsonl");
    await writeFile(
      filePath,
      '{"type":"user_message","ts":"now","text":"complete"}\n{"type":"assistant',
      "utf8",
    );

    await expect(new SessionStore(filePath).load()).resolves.toEqual([
      {
        type: "user_message",
        ts: "now",
        text: "complete",
      },
    ]);
  });

  it("parses a valid final record even when it has no newline", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "session.jsonl");
    await writeFile(
      filePath,
      '{"type":"user_message","ts":"now","text":"complete"}',
      "utf8",
    );

    await expect(new SessionStore(filePath).load()).resolves.toHaveLength(1);
  });

  it("repairs an incomplete tail before appending a new event", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "session.jsonl");
    await writeFile(
      filePath,
      '{"type":"user_message","ts":"now","text":"complete"}\n{"type":"broken',
      "utf8",
    );
    const store = new SessionStore(filePath);

    await store.append({ type: "assistant_final", text: "recovered" });

    await expect(store.load()).resolves.toMatchObject([
      { type: "user_message", text: "complete" },
      { type: "assistant_final", text: "recovered" },
    ]);
  });

  it("preserves a valid unterminated record before appending", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "session.jsonl");
    await writeFile(
      filePath,
      '{"type":"user_message","ts":"now","text":"complete"}',
      "utf8",
    );
    const store = new SessionStore(filePath);

    await store.append({ type: "assistant_final", text: "next" });

    await expect(store.load()).resolves.toHaveLength(2);
  });

  it.each([
    [
      "internal",
      '{"type":"user_message","ts":"now","text":"first"}\n{broken}\n{"type":"assistant_final","ts":"later","text":"last"}\n',
    ],
    [
      "newline-terminated final",
      '{"type":"user_message","ts":"now","text":"first"}\n{broken}\n',
    ],
  ])("still rejects %s JSONL corruption", async (_name, contents) => {
    const root = await makeRoot();
    const filePath = path.join(root, "session.jsonl");
    await writeFile(filePath, contents, "utf8");

    await expect(new SessionStore(filePath).load()).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it.runIf(process.platform !== "win32")(
    "refuses to read or append through a symlinked session target",
    async () => {
      const root = await makeRoot();
      const outside = await makeRoot();
      const filePath = path.join(root, "session.jsonl");
      const outsideFile = path.join(outside, "sensitive");
      await writeFile(outsideFile, "unchanged", "utf8");
      await symlink(outsideFile, filePath);
      const store = new SessionStore(filePath);

      await expect(store.load()).rejects.toThrow("symbolic link");
      await expect(
        store.append({ type: "user_message", text: "must not be written" }),
      ).rejects.toThrow("symbolic link");
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("unchanged");
    },
  );
});

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-session-store-"));
}
