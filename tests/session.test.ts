import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/agent/session.js";

const execFileAsync = promisify(execFile);

describe("SessionStore", () => {
  it("ignores only a malformed unterminated final JSONL fragment", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "session.jsonl");
    await writeFile(
      filePath,
      '{"type":"user_message","ts":"now","text":"complete"}\n{"type":"assistant',
      "utf8",
    );

    await expect(new SessionStore(filePath).load()).resolves.toMatchObject([
      {
        eventId: "legacy-session-1",
        sequence: 1,
        sessionId: "session",
        timestamp: "now",
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

  it("serializes concurrent appends with durable event envelopes", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "concurrent.jsonl");
    const first = new SessionStore(filePath);
    const second = new SessionStore(filePath);

    const appended = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? first : second).append({
          type: "user_message",
          text: `message-${index}`,
        }),
      ),
    );
    const events = await first.load();

    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.eventId))).toHaveLength(40);
    expect(events).toEqual(
      expect.arrayContaining(
        appended.map((event) =>
          expect.objectContaining({
            eventId: event.eventId,
            sequence: event.sequence,
            sessionId: "concurrent",
            timestamp: event.ts,
          }),
        ),
      ),
    );
  });

  it("serializes sequence allocation across processes", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "cross-process.jsonl");
    const script = [
      'import { SessionStore } from "./src/agent/session.ts";',
      "const [filePath, prefix] = process.argv.slice(1);",
      'const store = new SessionStore(filePath, "cross-process");',
      "for (let index = 0; index < 20; index += 1) {",
      "  await store.append({ type: \"user_message\", text: `${prefix}-${index}` });",
      "}",
    ].join("\n");

    await Promise.all(
      ["first", "second"].map((prefix) =>
        execFileAsync(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          script,
          filePath,
          prefix,
        ]),
      ),
    );

    const events = await new SessionStore(filePath).load();
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.eventId))).toHaveLength(40);
  });

  it("recovers an aged malformed append lock left by a crashed process", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "stale-lock.jsonl");
    const lockPath = `${filePath}.append.lock`;
    await writeFile(lockPath, "{partial", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const appended = await new SessionStore(filePath).append({
      type: "user_message",
      text: "recovered",
    });

    expect(appended.sequence).toBe(1);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("continues sequence numbers when upgrading a legacy log", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "legacy-id.jsonl");
    await writeFile(
      filePath,
      [
        '{"type":"user_message","ts":"first","text":"one"}',
        '{"type":"assistant_final","ts":"second","text":"two"}',
        "",
      ].join("\n"),
      "utf8",
    );
    const store = new SessionStore(filePath);

    const appended = await store.append({
      type: "user_message",
      text: "three",
    });
    const events = await store.load();

    expect(appended.sequence).toBe(3);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[0]).toMatchObject({
      eventId: "legacy-legacy-id-1",
      sessionId: "legacy-id",
      timestamp: "first",
    });
  });

  it("reports appended sequence progress without risking the event commit", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "observed.jsonl");
    const observed: number[] = [];
    const store = new SessionStore(filePath, "observed", async (event) => {
      observed.push(event.sequence);
      throw new Error("metadata cache unavailable");
    });

    await expect(
      store.append({ type: "user_message", text: "durable first" }),
    ).resolves.toMatchObject({ sequence: 1 });
    await expect(store.load()).resolves.toHaveLength(1);
    expect(observed).toEqual([1]);
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
