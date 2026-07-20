import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/agent/session.js";
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
  it("leaves read-only tools unchanged and reports no rewind point", async () => {
    const root = await fixture();
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-empty");
    const session = sessionStore(root, "session-empty");
    const read = new ReadTool(workspace);

    expect(manager.wrap(read)).toBe(read);
    await expect(manager.rewindLatestTurn(session)).resolves.toEqual({
      rewound: false,
      message: "No Montane conversation turn is available to rewind.",
      revertedPaths: [],
    });
  });

  it("restores the latest edit", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.txt"), "before\n");
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-a");
    const session = sessionStore(root, "session-a");
    await session.append({
      type: "user_message",
      text: "edit a",
      turnId: "turn-a",
    });
    const result = await manager.wrap(new EditTool(workspace)).execute(
      { file_path: "a.txt", old_string: "before", new_string: "after" },
      { toolCallId: "edit-1", taskRunId: "turn-a" },
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
    await expect(manager.rewindLatestTurn(session)).resolves.toMatchObject({
      rewound: true,
      revertedPaths: ["a.txt"],
    });
    await expect(readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe("before\n");
    await expect(session.load()).resolves.toMatchObject([
      { type: "session_rewind", targetSequence: 0, turnId: "turn-a" },
      { type: "session_status_changed", status: "running" },
    ]);
  });

  it("removes a newly created file", async () => {
    const root = await fixture();
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-b");
    const session = sessionStore(root, "session-b");
    await session.append({
      type: "user_message",
      text: "create a file",
      turnId: "turn-b",
    });
    await manager.wrap(new WriteTool(workspace)).execute(
      { file_path: "created.txt", content: "created\n" },
      { toolCallId: "write-1", taskRunId: "turn-b" },
    );

    await expect(manager.rewindLatestTurn(session)).resolves.toMatchObject({
      rewound: true,
    });
    await expect(readFile(path.join(root, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite changes made after a checkpoint", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.txt"), "before\n");
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-c");
    const session = sessionStore(root, "session-c");
    await session.append({
      type: "user_message",
      text: "edit a",
      turnId: "turn-c",
    });
    await manager.wrap(new EditTool(workspace)).execute(
      { file_path: "a.txt", old_string: "before", new_string: "after" },
      { toolCallId: "edit-1", taskRunId: "turn-c" },
    );
    await writeFile(path.join(root, "a.txt"), "external\n");

    await expect(manager.rewindLatestTurn(session)).resolves.toMatchObject({
      rewound: false,
    });
    await expect(readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe("external\n");
    await expect(session.load()).resolves.toMatchObject([
      { type: "user_message", turnId: "turn-c" },
    ]);
  });

  it("rewinds every file change in the latest turn as one unit", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.txt"), "before\n");
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-turn");
    const session = sessionStore(root, "session-turn");
    await session.append({
      type: "user_message",
      text: "change two files",
      turnId: "turn-group",
    });
    const edit = manager.wrap(new EditTool(workspace));
    await edit.execute(
      { file_path: "a.txt", old_string: "before", new_string: "middle" },
      { toolCallId: "edit-first", taskRunId: "turn-group" },
    );
    await edit.execute(
      { file_path: "a.txt", old_string: "middle", new_string: "after" },
      { toolCallId: "edit-second", taskRunId: "turn-group" },
    );
    await manager.wrap(new WriteTool(workspace)).execute(
      { file_path: "b.txt", content: "created\n" },
      { toolCallId: "write-b", taskRunId: "turn-group" },
    );

    await expect(manager.rewindLatestTurn(session)).resolves.toMatchObject({
      rewound: true,
      revertedPaths: ["a.txt", "b.txt"],
    });
    await expect(readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    await expect(readFile(path.join(root, "b.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves the whole turn untouched when any file conflicts", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.txt"), "a-before\n");
    await writeFile(path.join(root, "b.txt"), "b-before\n");
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-conflict");
    const session = sessionStore(root, "session-conflict");
    await session.append({
      type: "user_message",
      text: "change both",
      turnId: "turn-conflict",
    });
    const edit = manager.wrap(new EditTool(workspace));
    await edit.execute(
      { file_path: "a.txt", old_string: "a-before", new_string: "a-after" },
      { toolCallId: "edit-a", taskRunId: "turn-conflict" },
    );
    await edit.execute(
      { file_path: "b.txt", old_string: "b-before", new_string: "b-after" },
      { toolCallId: "edit-b", taskRunId: "turn-conflict" },
    );
    await writeFile(path.join(root, "b.txt"), "external\n");

    await expect(manager.rewindLatestTurn(session)).resolves.toMatchObject({
      rewound: false,
      revertedPaths: [],
    });
    await expect(readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe(
      "a-after\n",
    );
    await expect(readFile(path.join(root, "b.txt"), "utf8")).resolves.toBe(
      "external\n",
    );
  });

  it("does not checkpoint a failed write", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "exists.txt"), "existing\n");
    const workspace = new Workspace(root);
    const manager = checkpointManager(workspace, root, "session-failed");
    const session = sessionStore(root, "session-failed");
    await session.append({
      type: "user_message",
      text: "failed write",
      turnId: "turn-failed",
    });
    const result = await manager.wrap(new WriteTool(workspace)).execute(
      { file_path: "exists.txt", content: "replacement\n" },
      { toolCallId: "write-failed", taskRunId: "turn-failed" },
    );

    expect(result.ok).toBe(false);
    await expect(manager.rewindLatestTurn(session)).resolves.toMatchObject({
      rewound: true,
      revertedPaths: [],
    });
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

function sessionStore(root: string, sessionId: string): SessionStore {
  return new SessionStore(
    path.join(
      root,
      ".montane",
      "sessions",
      sessionId,
      "events.jsonl",
    ),
    sessionId,
  );
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "montane-checkpoint-"));
  roots.push(root);
  return root;
}
