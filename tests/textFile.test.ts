import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FileOperationError,
  atomicCreateTextFile,
  atomicReplaceTextFile,
  readTextFileSnapshot,
} from "../src/runtime/textFile.js";
import { Workspace } from "../src/runtime/workspace.js";

describe("text file safety layer", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-text-file-"));
    workspace = new Workspace(root);
  });

  it("reports hash, byte size, line endings, and mode", async () => {
    const filePath = path.join(root, "sample.txt");
    const text = "alpha\r\nbeta\r\n";
    await writeFile(filePath, text);
    await chmod(filePath, 0o640);

    const snapshot = await readTextFileSnapshot(workspace, "sample.txt");

    expect(snapshot.text).toBe(text);
    expect(snapshot.size).toBe(Buffer.byteLength(text));
    expect(snapshot.hash).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(snapshot.lineEnding).toBe("crlf");
    expect(snapshot.mode).toBe(0o640);
    expect(snapshot.dev).toBeTypeOf("number");
    expect(snapshot.ino).toBeTypeOf("number");
  });

  it("rejects replacement when the expected snapshot is stale", async () => {
    await writeFile(path.join(root, "stale.txt"), "first\n");
    const snapshot = await readTextFileSnapshot(workspace, "stale.txt", {
      forEdit: true,
    });
    await writeFile(path.join(root, "stale.txt"), "other\n");

    await expect(
      atomicReplaceTextFile(snapshot, "replacement\n"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path.join(root, "stale.txt"), "utf8")).toBe("other\n");
    expect(await readdir(root)).toEqual(["stale.txt"]);
  });

  it("does not silently overwrite between concurrent replacements", async () => {
    await writeFile(path.join(root, "race.txt"), "base\n");
    const snapshot = await readTextFileSnapshot(workspace, "race.txt", {
      forEdit: true,
    });

    const results = await Promise.allSettled([
      atomicReplaceTextFile(snapshot, "one\n"),
      atomicReplaceTextFile(snapshot, "two\n"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: { code: "conflict" },
    });
    expect(["one\n", "two\n"]).toContain(
      await readFile(path.join(root, "race.txt"), "utf8"),
    );
  });

  it("creates atomically without replacing an existing file", async () => {
    await writeFile(path.join(root, "existing.txt"), "keep");

    await expect(
      atomicCreateTextFile(workspace, "existing.txt", "replace"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path.join(root, "existing.txt"), "utf8")).toBe("keep");

    await mkdir(path.join(root, "nested"));
    const created = await atomicCreateTextFile(
      workspace,
      "nested/new.txt",
      "new\n",
      { mode: 0o640 },
    );
    expect(created.text).toBe("new\n");
    expect(created.mode).toBe(0o640);
  });

  it("requires the parent directory to exist", async () => {
    await expect(
      atomicCreateTextFile(workspace, "missing/new.txt", "new\n"),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects binary, invalid UTF-8, and oversized files", async () => {
    await writeFile(path.join(root, "binary.dat"), Buffer.from([65, 0, 66]));
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(root, "large.txt"), "12345");

    await expect(
      readTextFileSnapshot(workspace, "binary.dat"),
    ).rejects.toMatchObject({ code: "binary_file" });
    await expect(
      readTextFileSnapshot(workspace, "invalid.txt"),
    ).rejects.toMatchObject({ code: "invalid_encoding" });
    await expect(
      readTextFileSnapshot(workspace, "large.txt", { maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "output_limit" });
    await expect(
      atomicCreateTextFile(workspace, "too-large.txt", "12345", {
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "output_limit" });
  });

  it("allows safe symlink reads but refuses symlink edits", async () => {
    await writeFile(path.join(root, "target.txt"), "linked\n");
    await symlink("target.txt", path.join(root, "link.txt"));

    expect((await readTextFileSnapshot(workspace, "link.txt")).text).toBe(
      "linked\n",
    );
    await expect(
      readTextFileSnapshot(workspace, "link.txt", { forEdit: true }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("cleans temporary and lock files after success and failure", async () => {
    const created = await atomicCreateTextFile(workspace, "clean.txt", "old\n");
    await atomicReplaceTextFile(created, "new\n");
    await expect(
      atomicCreateTextFile(workspace, "clean.txt", "again\n"),
    ).rejects.toBeInstanceOf(FileOperationError);

    expect(await readdir(root)).toEqual(["clean.txt"]);
  });

  it("recovers abandoned edit locks but respects active owners", async () => {
    const filePath = path.join(root, "locked.txt");
    const lockPath = path.join(root, ".locked.txt.text-file.lock");
    await writeFile(filePath, "old\n");
    const snapshot = await readTextFileSnapshot(workspace, "locked.txt", {
      forEdit: true,
    });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647 }),
      "utf8",
    );

    await expect(
      atomicReplaceTextFile(snapshot, "new\n"),
    ).resolves.toMatchObject({ text: "new\n" });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.ppid }),
      "utf8",
    );
    const latest = await readTextFileSnapshot(workspace, "locked.txt", {
      forEdit: true,
    });

    await expect(
      atomicReplaceTextFile(latest, "blocked\n"),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "concurrent_edit" },
    });
    expect(await readFile(filePath, "utf8")).toBe("new\n");
    await unlink(lockPath);
  });

  it("does not steal a newly-created lock before its owner metadata is written", async () => {
    const filePath = path.join(root, "pending.txt");
    const lockPath = path.join(root, ".pending.txt.text-file.lock");
    await writeFile(filePath, "old\n");
    await writeFile(lockPath, "");
    const snapshot = await readTextFileSnapshot(workspace, "pending.txt", {
      forEdit: true,
    });

    await expect(
      atomicReplaceTextFile(snapshot, "new\n"),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "concurrent_edit" },
    });
    expect(await readFile(filePath, "utf8")).toBe("old\n");
    await unlink(lockPath);
  });
});
