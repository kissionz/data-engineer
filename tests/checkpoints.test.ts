import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../src/runtime/checkpoints.js";
import { Workspace } from "../src/runtime/workspace.js";
import { EditTool } from "../src/tools/edit.js";
import { WriteTool } from "../src/tools/write.js";
import { ReadTool } from "../src/tools/read.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CheckpointManager", () => {
  it("leaves read-only tools unchanged and reports an empty undo stack", async () => {
    const root = await fixture();
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-empty");
    const read = new ReadTool(workspace);

    expect(manager.wrap(read)).toBe(read);
    await expect(manager.undoLatest()).resolves.toEqual({
      restored: false,
      message: "No Montane edit checkpoint is available.",
    });
  });

  it("restores the latest edit", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.txt"), "before\n");
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-a");
    const result = await manager.wrap(new EditTool(workspace)).execute(
      { file_path: "a.txt", old_string: "before", new_string: "after" },
      { toolCallId: "edit-1" },
    );

    expect(result.ok).toBe(true);
    await expect(
      readFile(
        path.join(
          root,
          ".montane",
          "sessions",
          "session-a",
          "checkpoints.json",
        ),
        "utf8",
      ),
    ).resolves.toContain('"toolCallId":"edit-1"');
    await expect(manager.undoLatest()).resolves.toMatchObject({ restored: true });
    await expect(readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe("before\n");
  });

  it("removes a newly created file", async () => {
    const root = await fixture();
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-b");
    await manager.wrap(new WriteTool(workspace)).execute(
      { file_path: "created.txt", content: "created\n" },
      { toolCallId: "write-1" },
    );

    await expect(manager.undoLatest()).resolves.toMatchObject({ restored: true });
    await expect(readFile(path.join(root, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite changes made after a checkpoint", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.txt"), "before\n");
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-c");
    await manager.wrap(new EditTool(workspace)).execute(
      { file_path: "a.txt", old_string: "before", new_string: "after" },
      { toolCallId: "edit-1" },
    );
    await writeFile(path.join(root, "a.txt"), "external\n");

    await expect(manager.undoLatest()).resolves.toMatchObject({ restored: false });
    await expect(readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe("external\n");
  });

  it("does not checkpoint a failed write", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "exists.txt"), "existing\n");
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-failed");
    const result = await manager.wrap(new WriteTool(workspace)).execute(
      { file_path: "exists.txt", content: "replacement\n" },
      { toolCallId: "write-failed" },
    );

    expect(result.ok).toBe(false);
    await expect(manager.undoLatest()).resolves.toMatchObject({ restored: false });
  });

  it("rejects checkpoint storage outside a managed session directory", async () => {
    const root = await fixture();
    const workspace = new Workspace(root);

    expect(() => new CheckpointManager(workspace, root)).toThrow(
      "one managed session directory",
    );
    expect(
      () => new CheckpointManager(
        workspace,
        path.join(root, ".montane", "sessions", "parent", "nested"),
      ),
    ).toThrow("one managed session directory");
  });
});

function checkpointManager(
  workspace: Workspace,
  root: string,
  sessionId: string,
): CheckpointManager {
  return new CheckpointManager(
    workspace,
    path.join(root, ".montane", "sessions", sessionId),
  );
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "montane-checkpoint-"));
  roots.push(root);
  return root;
}
