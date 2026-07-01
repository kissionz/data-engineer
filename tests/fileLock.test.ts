import {
  mkdtemp,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireFileLock } from "../src/runtime/fileLock.js";

describe("acquireFileLock", () => {
  it("serializes ownership and releases only the acquired lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-lock-"));
    const target = path.join(root, "store.jsonl");
    const release = await acquireFileLock(target);

    await expect(
      acquireFileLock(target, { timeoutMs: 20, label: "test" }),
    ).rejects.toThrow("Timed out waiting for test lock");

    await release();
    const releaseAgain = await acquireFileLock(target, { timeoutMs: 20 });
    await releaseAgain();
    await expect(readFile(`${target}.lock`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers an aged malformed lock without trusting its contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-lock-"));
    const target = path.join(root, "store.jsonl");
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, "{malformed", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const release = await acquireFileLock(target, { staleMs: 30_000 });
    await release();

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
