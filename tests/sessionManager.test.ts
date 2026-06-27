import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/agent/session.js";
import { SessionManager } from "../src/agent/sessionManager.js";

describe("SessionManager", () => {
  it("creates isolated sessions and resumes the current session", async () => {
    const root = await makeRoot();
    const manager = new SessionManager(root);
    const first = await manager.create();
    const second = await manager.create();

    expect(first.id).not.toBe(second.id);
    await expect(manager.resume("latest")).resolves.toMatchObject({
      id: second.id,
    });
    await expect(manager.resume(first.id)).resolves.toMatchObject({
      id: first.id,
    });
    await expect(manager.list()).resolves.toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(first.todoPath).not.toBe(second.todoPath);
    await expect(readFile(first.todoPath, "utf8")).resolves.toBe("[]\n");
    await first.release();
    await second.release();
  });

  it("creates and atomically updates session metadata", async () => {
    const root = await makeRoot();
    const manager = new SessionManager(root, {
      model: "production-model",
      parentSessionId: "parent-session",
    });
    const session = await manager.create();
    const created = await session.readMetadata();

    expect(created).toMatchObject({
      id: session.id,
      workspaceRoot: path.resolve(root),
      model: "production-model",
      status: "running",
      lastSequence: 0,
      parentSessionId: "parent-session",
    });
    expect(created.createdAt).toBe(created.updatedAt);

    await session.updateLastSequence(7);
    await session.updateLastSequence(3);
    const completed = await session.updateStatus("completed");

    expect(completed).toMatchObject({
      status: "completed",
      lastSequence: 7,
    });
    await expect(
      readFile(session.metadataPath, "utf8").then(JSON.parse),
    ).resolves.toMatchObject(completed);
    expect(
      (await readdir(path.dirname(session.metadataPath))).filter((name) =>
        name.includes(".meta.json."),
      ),
    ).toEqual([]);
    await session.release();
  });

  it("adds metadata when resuming an old flat-layout session", async () => {
    const root = await makeRoot();
    const sessionsDir = path.join(root, ".harness", "sessions");
    const todosDir = path.join(root, ".harness", "todos");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(todosDir);
    await writeFile(
      path.join(sessionsDir, "old-session.jsonl"),
      [
        '{"type":"user_message","ts":"one","text":"legacy"}',
        '{"type":"assistant_final","ts":"two","text":"done"}',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(todosDir, "old-session.json"), "[]\n", "utf8");

    const session = await new SessionManager(root, {
      model: "resume-model",
    }).resume("old-session");
    const metadata = await session.readMetadata();

    expect(metadata).toMatchObject({
      id: "old-session",
      workspaceRoot: path.resolve(root),
      model: "resume-model",
      status: "completed",
      lastSequence: 2,
    });
    await expect(readFile(session.metadataPath, "utf8")).resolves.toContain(
      '"lastSequence": 2',
    );
    await session.release();
  });

  it("inspects current metadata without acquiring the writer lease", async () => {
    const root = await makeRoot();
    const owner = await new SessionManager(root, {
      model: "inspect-model",
    }).create();
    const observer = new SessionManager(root);

    await expect(observer.inspect("latest")).resolves.toMatchObject({
      id: owner.id,
      model: "inspect-model",
      status: "running",
    });
    await new SessionStore(owner.sessionPath, owner.id).append({
      type: "session_status_changed",
      status: "completed",
    });
    await expect(observer.inspect(owner.id)).resolves.toMatchObject({
      status: "completed",
      lastSequence: 1,
    });
    await new SessionStore(owner.sessionPath, owner.id).append({
      type: "approval_requested",
      toolCallId: "pending-call",
      fingerprint: "fingerprint",
      scope: "fingerprint",
      reason: "Needs confirmation.",
    });
    await expect(observer.inspect(owner.id)).resolves.toMatchObject({
      status: "waiting_for_approval",
      lastSequence: 2,
    });
    await expect(observer.resume(owner.id)).rejects.toThrow(
      "Session is already active",
    );
    await owner.release();
  });

  it("backfills metadata when inspecting an old session", async () => {
    const root = await makeRoot();
    const sessionsDir = path.join(root, ".harness", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, "inspect-old.jsonl"),
      '{"type":"user_message","ts":"one","text":"legacy"}\n',
      "utf8",
    );
    const manager = new SessionManager(root, { model: "inspect-model" });

    await expect(manager.inspect("inspect-old")).resolves.toMatchObject({
      id: "inspect-old",
      model: "inspect-model",
      lastSequence: 1,
    });
    await expect(
      readFile(path.join(sessionsDir, "inspect-old.meta.json"), "utf8"),
    ).resolves.toContain('"lastSequence": 1');
  });

  it("rebuilds corrupt regular metadata from the event log", async () => {
    const root = await makeRoot();
    const manager = new SessionManager(root, { model: "recovery-model" });
    const session = await manager.create();
    await new SessionStore(session.sessionPath, session.id).append({
      type: "assistant_final",
      text: "done",
    });
    await session.release();
    await writeFile(session.metadataPath, "{broken", "utf8");

    await expect(manager.inspect(session.id)).resolves.toMatchObject({
      id: session.id,
      model: "recovery-model",
      status: "completed",
      lastSequence: 1,
    });
    await expect(
      readFile(session.metadataPath, "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      id: session.id,
      status: "completed",
      lastSequence: 1,
    });
  });

  it("rejects unsafe or missing session ids", async () => {
    const root = await makeRoot();
    const manager = new SessionManager(root);

    await expect(manager.resume("../escape")).rejects.toThrow(
      "Invalid session id",
    );
    await expect(manager.resume("missing")).rejects.toThrow(
      "Session not found",
    );
  });

  it("migrates legacy latest session and todo files to a real id", async () => {
    const root = await makeRoot();
    const sessionsDir = path.join(root, ".harness", "sessions");
    const todosDir = path.join(root, ".harness", "todos");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(todosDir);
    await writeFile(
      path.join(sessionsDir, "latest.jsonl"),
      '{"type":"user_message","ts":"now","text":"legacy"}\n',
      "utf8",
    );
    await writeFile(path.join(todosDir, "latest.json"), '[{"legacy":true}]\n', "utf8");

    const resumed = await new SessionManager(root).resume("latest");

    expect(resumed.id).not.toBe("latest");
    await expect(readFile(resumed.sessionPath, "utf8")).resolves.toContain(
      '"text":"legacy"',
    );
    await expect(readFile(resumed.todoPath, "utf8")).resolves.toContain(
      '"legacy":true',
    );
    await expect(lstat(path.join(sessionsDir, "latest.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(todosDir, "latest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(sessionsDir, "current"), "utf8")).resolves.toBe(
      `${resumed.id}\n`,
    );
  });

  it("preserves a legacy session during a default new-session startup", async () => {
    const root = await makeRoot();
    const sessionsDir = path.join(root, ".harness", "sessions");
    const todosDir = path.join(root, ".harness", "todos");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(todosDir);
    await writeFile(
      path.join(sessionsDir, "latest.jsonl"),
      '{"type":"user_message","ts":"now","text":"legacy"}\n',
      "utf8",
    );
    await writeFile(path.join(todosDir, "latest.json"), "[]\n", "utf8");
    const manager = new SessionManager(root);

    const current = await manager.start();
    const sessions = await manager.list();
    const migratedId = sessions.find((id) => id !== current.id);

    expect(migratedId).toBeDefined();
    await expect(
      readFile(path.join(sessionsDir, `${migratedId}.jsonl`), "utf8"),
    ).resolves.toContain('"text":"legacy"');
  });

  it("upgrades an old current pointer whose value is latest", async () => {
    const root = await makeRoot();
    const sessionsDir = path.join(root, ".harness", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "latest.jsonl"), "", "utf8");
    await writeFile(path.join(sessionsDir, "current"), "latest\n", "utf8");

    const resumed = await new SessionManager(root).resume("latest");

    expect(resumed.id).not.toBe("latest");
    await resumed.release();
    const resumedAgain = await new SessionManager(root).resume("latest");
    expect(resumedAgain).toMatchObject({
      id: resumed.id,
    });
    await resumedAgain.release();
  });

  it("prevents concurrent use and recovers a dead-process lease", async () => {
    const root = await makeRoot();
    const owner = await new SessionManager(root).create();
    const contender = new SessionManager(root);

    await expect(contender.resume(owner.id)).rejects.toThrow(
      "Session is already active",
    );
    await owner.release();

    const lockPath = path.join(
      root,
      ".harness",
      "sessions",
      ".locks",
      `${owner.id}.lock`,
    );
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        hostname: os.hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
        token: "stale-token",
      })}\n`,
      "utf8",
    );

    const recovered = await contender.resume(owner.id);
    expect(recovered.id).toBe(owner.id);
    await recovered.release();
  });

  it.each([
    ["empty", ""],
    ["malformed", "../escape\n"],
  ])("reports an explicit error for an %s current pointer", async (_name, value) => {
    const root = await makeRoot();
    const sessionsDir = path.join(root, ".harness", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "current"), value, "utf8");

    await expect(new SessionManager(root).resume("latest")).rejects.toThrow(
      /Current session pointer is (empty|invalid)/,
    );
  });

  it("uses a same-directory temporary file and leaves only current behind", async () => {
    const root = await makeRoot();
    const session = await new SessionManager(root).create();
    const sessionsDir = path.join(root, ".harness", "sessions");

    expect(await readdir(sessionsDir)).toEqual(
      expect.arrayContaining(["current", `${session.id}.jsonl`]),
    );
    expect((await readdir(sessionsDir)).filter((name) => name.startsWith(".current.")))
      .toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects symbolic links in sensitive directories",
    async () => {
      const root = await makeRoot();
      const harnessDir = path.join(root, ".harness");
      const outside = await makeRoot();
      await mkdir(harnessDir);
      await symlink(outside, path.join(harnessDir, "sessions"));

      await expect(new SessionManager(root).create()).rejects.toThrow(
        "symbolic link",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked current, session, and todo targets without touching targets",
    async () => {
      const outside = await makeRoot();
      const outsideFile = path.join(outside, "sensitive");
      await writeFile(outsideFile, "unchanged", "utf8");

      const currentRoot = await makeRoot();
      const currentSessions = path.join(currentRoot, ".harness", "sessions");
      await mkdir(currentSessions, { recursive: true });
      await symlink(outsideFile, path.join(currentSessions, "current"));
      await expect(new SessionManager(currentRoot).create()).rejects.toThrow(
        "symbolic link",
      );

      const sessionRoot = await makeRoot();
      const sessionDir = path.join(sessionRoot, ".harness", "sessions");
      const todoDir = path.join(sessionRoot, ".harness", "todos");
      await mkdir(sessionDir, { recursive: true });
      await mkdir(todoDir);
      await symlink(outsideFile, path.join(sessionDir, "known.jsonl"));
      await expect(new SessionManager(sessionRoot).resume("known")).rejects.toThrow(
        "symbolic link",
      );

      const todoRoot = await makeRoot();
      const managed = await new SessionManager(todoRoot).create();
      await import("node:fs/promises").then(({ unlink }) => unlink(managed.todoPath));
      await symlink(outsideFile, managed.todoPath);
      await expect(new SessionManager(todoRoot).resume(managed.id)).rejects.toThrow(
        "symbolic link",
      );
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("unchanged");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked legacy latest file",
    async () => {
      const root = await makeRoot();
      const outside = await makeRoot();
      const sessionsDir = path.join(root, ".harness", "sessions");
      const outsideFile = path.join(outside, "legacy.jsonl");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(outsideFile, "sensitive", "utf8");
      await symlink(outsideFile, path.join(sessionsDir, "latest.jsonl"));

      await expect(new SessionManager(root).resume("latest")).rejects.toThrow(
        "symbolic link",
      );
    },
  );
});

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-sessions-"));
}
