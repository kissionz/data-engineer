import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/agent/sessionManager.js";

describe("SessionManager", () => {
  it("creates isolated sessions and resumes the current session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-sessions-"));
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
  });

  it("rejects unsafe or missing session ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-sessions-"));
    const manager = new SessionManager(root);

    await expect(manager.resume("../escape")).rejects.toThrow(
      "Invalid session id",
    );
    await expect(manager.resume("missing")).rejects.toThrow(
      "Session not found",
    );
  });

  it("can resume the legacy latest session when no pointer exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-sessions-"));
    const sessionsDir = path.join(root, ".harness", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "latest.jsonl"), "", "utf8");

    await expect(new SessionManager(root).resume("latest")).resolves.toMatchObject({
      id: "latest",
    });
  });
});
