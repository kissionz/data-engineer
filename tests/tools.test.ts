import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CommandExecutor,
  CommandOptions,
} from "../src/runtime/commandExecutor.js";
import type {
  ShellExecutor,
  ShellOptions,
} from "../src/runtime/shellExecutor.js";
import { Workspace } from "../src/runtime/workspace.js";
import { BashTool } from "../src/tools/bash.js";
import { EditTool } from "../src/tools/edit.js";
import { GitDiffTool, GitStatusTool } from "../src/tools/git.js";
import { GlobTool } from "../src/tools/glob.js";
import { GrepTool } from "../src/tools/grep.js";
import { ReadTool } from "../src/tools/read.js";
import { TodoReadTool, TodoStore, TodoWriteTool } from "../src/tools/todo.js";
import { WriteTool } from "../src/tools/write.js";

describe("P0 tools", () => {
  it("reads files with line numbers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    await writeFile(path.join(root, "sample.txt"), "one\ntwo\nthree", "utf8");

    const result = await new ReadTool(new Workspace(root)).execute({
      file_path: "sample.txt",
      offset: 1,
      limit: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("2 | two");
    expect(result.data).toMatchObject({
      sha256: createHash("sha256")
        .update("one\ntwo\nthree")
        .digest("hex"),
      size: 13,
      encoding: "utf-8",
      bom: false,
      lineEnding: "lf",
    });
  });

  it("returns the same full-file hash for paginated reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    await writeFile(path.join(root, "sample.txt"), "one\ntwo\nthree", "utf8");
    const tool = new ReadTool(new Workspace(root));

    const first = await tool.execute({
      file_path: "sample.txt",
      offset: 0,
      limit: 1,
    });
    const last = await tool.execute({
      file_path: "sample.txt",
      offset: 2,
      limit: 1,
    });

    expect(first.data?.sha256).toBe(last.data?.sha256);
    expect(first.data?.truncated).toBe(true);
  });

  it("requires approval before reading outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
    const outsidePath = path.join(outside, "shared.txt");
    await writeFile(outsidePath, "shared content", "utf8");
    const tool = new ReadTool(new Workspace(root));

    const denied = await tool.execute({ file_path: outsidePath });
    const approved = await tool.execute(
      { file_path: outsidePath },
      { toolCallId: "approved-read", userApproved: true },
    );

    expect(denied.ok).toBe(false);
    expect(approved.ok).toBe(true);
    expect(approved.content).toContain("shared content");
  });

  it("allows approved writes and edits outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
    const outsidePath = path.join(outside, "shared.txt");
    const context = { toolCallId: "approved-write", userApproved: true };
    const workspace = new Workspace(root);

    const created = await new WriteTool(workspace).execute(
      { file_path: outsidePath, content: "first version" },
      context,
    );
    const edited = await new EditTool(workspace).execute(
      {
        file_path: outsidePath,
        old_string: "first",
        new_string: "second",
      },
      { toolCallId: "approved-edit", userApproved: true },
    );

    expect(created.ok).toBe(true);
    expect(edited.ok).toBe(true);
    expect(await readFile(outsidePath, "utf8")).toBe("second version");
  });

  it.runIf(process.platform !== "win32")(
    "does not let a folder grant follow a symlink outside that folder",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
      const approved = await mkdtemp(
        path.join(os.tmpdir(), "harness-approved-"),
      );
      const unapproved = await mkdtemp(
        path.join(os.tmpdir(), "harness-unapproved-"),
      );
      const secretPath = path.join(unapproved, "secret.txt");
      const linkPath = path.join(approved, "linked-secret.txt");
      await writeFile(secretPath, "outside approved folder", "utf8");
      await symlink(secretPath, linkPath);

      const result = await new ReadTool(new Workspace(root)).execute(
        { file_path: linkPath },
        {
          toolCallId: "folder-grant-symlink",
          userApproved: true,
          approvedFolder: approved,
        },
      );

      expect(result.ok).toBe(false);
      expect(result.content).not.toContain("outside approved folder");
    },
  );

  it("edits only unique exact strings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const filePath = path.join(root, "sample.txt");
    await writeFile(filePath, "hello world", "utf8");

    const result = await new EditTool(new Workspace(root)).execute({
      file_path: "sample.txt",
      old_string: "world",
      new_string: "agent",
    });

    expect(result.ok).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("hello agent");
  });

  it("rejects a stale expected hash without changing the file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const filePath = path.join(root, "sample.txt");
    await writeFile(filePath, "first version", "utf8");
    const workspace = new Workspace(root);
    const read = await new ReadTool(workspace).execute({
      file_path: "sample.txt",
    });
    await writeFile(filePath, "external version", "utf8");

    const result = await new EditTool(workspace).execute({
      file_path: "sample.txt",
      old_string: "version",
      new_string: "change",
      expected_hash: read.data?.sha256,
    });

    expect(result).toMatchObject({
      ok: false,
      data: {
        code: "conflict",
        retryable: true,
        details: { reason: "expected_hash_mismatch" },
      },
    });
    expect(await readFile(filePath, "utf8")).toBe("external version");
  });

  it.runIf(process.platform !== "win32")(
    "preserves UTF-8 BOM, CRLF, and executable mode",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
      const filePath = path.join(root, "script.txt");
      const original = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("alpha\r\nbeta\r\n"),
      ]);
      await writeFile(filePath, original);
      await chmod(filePath, 0o755);
      const workspace = new Workspace(root);
      const read = await new ReadTool(workspace).execute({
        file_path: "script.txt",
      });

      const result = await new EditTool(workspace).execute({
        file_path: "script.txt",
        old_string: "alpha\nbeta",
        new_string: "one\ntwo",
        expected_hash: read.data?.sha256,
      });
      const updated = await readFile(filePath);

      expect(result.ok).toBe(true);
      expect(updated.subarray(0, 3)).toEqual(
        Buffer.from([0xef, 0xbb, 0xbf]),
      );
      expect(updated.subarray(3).toString("utf8")).toBe("one\r\ntwo\r\n");
      expect((await stat(filePath)).mode & 0o777).toBe(0o755);
    },
  );

  it("allows only one concurrent edit from the same snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const filePath = path.join(root, "race.txt");
    await writeFile(filePath, "base", "utf8");
    const workspace = new Workspace(root);
    const read = await new ReadTool(workspace).execute({
      file_path: "race.txt",
    });
    const edit = new EditTool(workspace);

    const results = await Promise.all([
      edit.execute({
        file_path: "race.txt",
        old_string: "base",
        new_string: "one",
        expected_hash: read.data?.sha256,
      }),
      edit.execute({
        file_path: "race.txt",
        old_string: "base",
        new_string: "two",
        expected_hash: read.data?.sha256,
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ code: "conflict" }),
      }),
    );
    expect(["one", "two"]).toContain(await readFile(filePath, "utf8"));
  });

  it("rejects binary files without changing their bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const bytes = Buffer.from([0xff, 0x00, 0x41]);
    await writeFile(path.join(root, "binary.dat"), bytes);
    const workspace = new Workspace(root);

    const read = await new ReadTool(workspace).execute({
      file_path: "binary.dat",
    });
    const edit = await new EditTool(workspace).execute({
      file_path: "binary.dat",
      old_string: "A",
      new_string: "B",
    });

    expect(read.data).toMatchObject({ code: "binary_file" });
    expect(edit.data).toMatchObject({ code: "binary_file" });
    expect(await readFile(path.join(root, "binary.dat"))).toEqual(bytes);
  });

  it("detects a target swapped to an external symlink before reading", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
    const targetPath = path.join(root, "target.txt");
    const outsidePath = path.join(outside, "secret.txt");
    await writeFile(targetPath, "safe", "utf8");
    await writeFile(outsidePath, "outside secret", "utf8");
    const workspace = new SwappingWorkspace(root, async (absolutePath) => {
      if (absolutePath !== targetPath) {
        return;
      }
      await unlink(targetPath);
      await symlink(outsidePath, targetPath);
    });

    const result = await new ReadTool(workspace).execute({
      file_path: "target.txt",
    }, {
      toolCallId: "approved-inside-symlink",
      userApproved: true,
    });

    expect(result).toMatchObject({
      ok: false,
      data: { code: "conflict" },
    });
    expect(result.content).not.toContain("outside secret");
    expect(await readFile(outsidePath, "utf8")).toBe("outside secret");
  });

  it("does not edit an external file after a symlink swap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
    const targetPath = path.join(root, "target.txt");
    const outsidePath = path.join(outside, "secret.txt");
    await writeFile(targetPath, "safe token", "utf8");
    await writeFile(outsidePath, "outside token", "utf8");
    const workspace = new SwappingWorkspace(root, async (absolutePath) => {
      if (absolutePath !== targetPath) {
        return;
      }
      await unlink(targetPath);
      await symlink(outsidePath, targetPath);
    });

    const result = await new EditTool(workspace).execute({
      file_path: "target.txt",
      old_string: "token",
      new_string: "changed",
    });

    expect(result).toMatchObject({
      ok: false,
      data: { code: "conflict" },
    });
    expect(await readFile(outsidePath, "utf8")).toBe("outside token");
  });

  it.runIf(process.platform !== "win32")(
    "does not publish a new file after its parent is swapped",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
      const outside = await mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
      const parentPath = path.join(root, "nested");
      await mkdir(parentPath);
      const workspace = new SwappingWorkspace(root, async (absolutePath) => {
        if (absolutePath !== parentPath) {
          return;
        }
        await rename(parentPath, path.join(root, "original-parent"));
        await symlink(outside, parentPath, "dir");
      });

      const result = await new WriteTool(workspace).execute({
        file_path: "nested/new.txt",
        content: "must stay inside",
      });

      expect(result).toMatchObject({
        ok: false,
        data: { code: "conflict" },
      });
      await expect(access(path.join(outside, "new.txt"))).rejects.toThrow();
    },
  );


  it("creates new files without overwriting existing files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    await mkdir(path.join(root, "nested"));
    const tool = new WriteTool(new Workspace(root));

    const created = await tool.execute({
      file_path: "nested/sample.txt",
      content: "hello",
    });
    const overwritten = await tool.execute({
      file_path: "nested/sample.txt",
      content: "changed",
    });

    expect(created.ok).toBe(true);
    expect(overwritten.ok).toBe(false);
    expect(overwritten.data).toMatchObject({
      code: "conflict",
      retryable: true,
      details: { reason: "already_exists" },
    });
    expect(await readFile(path.join(root, "nested/sample.txt"), "utf8")).toBe(
      "hello",
    );
  });

  it("does not write or edit after task cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const existingPath = path.join(root, "existing.txt");
    await writeFile(existingPath, "before", "utf8");
    const controller = new AbortController();
    controller.abort();
    const context = {
      toolCallId: "cancelled-call",
      signal: controller.signal,
    };

    await expect(
      new WriteTool(new Workspace(root)).execute(
        { file_path: "new.txt", content: "new" },
        context,
      ),
    ).rejects.toMatchObject({ name: "AgentCancelledError" });
    await expect(
      new EditTool(new Workspace(root)).execute(
        {
          file_path: "existing.txt",
          old_string: "before",
          new_string: "after",
        },
        context,
      ),
    ).rejects.toMatchObject({ name: "AgentCancelledError" });

    await expect(readFile(path.join(root, "new.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(existingPath, "utf8")).toBe("before");
  });

  it("rejects non-unique edit strings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    await writeFile(path.join(root, "sample.txt"), "x x", "utf8");

    const result = await new EditTool(new Workspace(root)).execute({
      file_path: "sample.txt",
      old_string: "x",
      new_string: "y",
    });

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      code: "conflict",
      retryable: true,
      details: { reason: "old_string_not_unique", count: 2 },
    });
  });

  it("runs bash through the command executor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const calls: ShellOptions[] = [];
    const executor: ShellExecutor = {
      async runScript(options) {
        calls.push(options);
        return {
          ok: true,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          cancelled: false,
        };
      },
    };

    const result = await new BashTool(new Workspace(root), executor).execute({
      command: "echo ok",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("ok");
    expect(calls[0]?.cwd).toBe(root);
    expect(calls[0]?.script).toBe("echo ok");
  });

  it("passes tool cancellation to bash and returns a structured result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const controller = new AbortController();
    const calls: ShellOptions[] = [];
    const executor: ShellExecutor = {
      async runScript(options) {
        calls.push(options);
        return {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          cancelled: true,
        };
      },
    };

    const result = await new BashTool(new Workspace(root), executor).execute(
      { command: "sleep 100" },
      { toolCallId: "call-1", signal: controller.signal },
    );

    expect(calls[0]?.signal).toBe(controller.signal);
    expect(result).toMatchObject({
      ok: false,
      data: {
        code: "cancelled",
        retryable: false,
        timedOut: false,
        cancelled: true,
      },
    });
  });

  it("runs grep through ripgrep with workspace constrained path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const calls: CommandOptions[] = [];
    const executor: CommandExecutor = {
      async run(options) {
        calls.push(options);
        return {
          ok: true,
          exitCode: 0,
          stdout: "sample.txt:1:AgentLoop",
          stderr: "",
          timedOut: false,
          cancelled: false,
        };
      },
    };

    const result = await new GrepTool(new Workspace(root), executor).execute({
      pattern: "AgentLoop",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("AgentLoop");
    expect(calls[0]?.cwd).toBe(root);
    expect(calls[0]?.command).toBe("rg");
    expect(calls[0]?.args).toContain("--line-number");
    expect(calls[0]?.args).toContain("AgentLoop");
  });

  it("lists matching files with a bounded Glob result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const calls: CommandOptions[] = [];
    const executor: CommandExecutor = {
      async run(options) {
        calls.push(options);
        return {
          ok: true,
          exitCode: 0,
          stdout: [
            path.join(root, "src", "a.ts"),
            path.join(root, "src", "b.ts"),
            path.join(root, "src", "c.ts"),
          ].join("\n"),
          stderr: "",
          timedOut: false,
          cancelled: false,
        };
      },
    };

    const result = await new GlobTool(new Workspace(root), executor).execute({
      pattern: "**/*.ts",
      limit: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain(path.join("src", "a.ts"));
    expect(result.content).not.toContain(path.join("src", "c.ts"));
    expect(result.data).toMatchObject({ count: 2, truncated: true });
    expect(calls[0]).toMatchObject({
      command: "rg",
    });
    expect(calls[0]?.args).toContain("**/*.ts");
  });

  it("runs Git status and diff without a shell", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const calls: CommandOptions[] = [];
    const executor: CommandExecutor = {
      async run(options) {
        calls.push(options);
        return {
          ok: true,
          exitCode: 0,
          stdout: " M src/index.ts",
          stderr: "",
          timedOut: false,
          cancelled: false,
        };
      },
    };
    const workspace = new Workspace(root);

    await new GitStatusTool(workspace, executor).execute({});
    await new GitDiffTool(workspace, executor).execute({ staged: true });

    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["status", "--short"],
    });
    expect(calls[1]).toMatchObject({
      command: "git",
      args: [
        "diff",
        "--cached",
        "--",
        ".",
        ":(exclude)**/.env",
        ":(exclude)**/.env.*",
        ":(exclude)**/node_modules/**",
      ],
    });
  });

  it("persists and validates task todos", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const store = new TodoStore(path.join(root, "todos.json"));
    const write = new TodoWriteTool(store);
    const read = new TodoReadTool(new TodoStore(path.join(root, "todos.json")));
    const todos = [
      { content: "Inspect", status: "done" },
      { content: "Implement", status: "in_progress" },
    ];

    expect((await write.execute({ todos })).ok).toBe(true);
    expect(await read.execute({})).toMatchObject({
      ok: true,
      data: { todos },
    });

    const invalid = await write.execute({
      todos: [
        { content: "One", status: "in_progress" },
        { content: "Two", status: "in_progress" },
      ],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.content).toContain("Only one todo");
  });

  it.runIf(process.platform !== "win32")(
    "refuses to read or write a symlinked todo file",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
      const outside = path.join(root, "outside.json");
      const linked = path.join(root, "todos.json");
      await writeFile(outside, "[]\n", "utf8");
      await symlink(outside, linked);
      const store = new TodoStore(linked);

      await expect(store.read()).rejects.toThrow("symbolic link");
      await expect(
        store.write([{ content: "Unsafe", status: "pending" }]),
      ).rejects.toThrow("symbolic link");
      await expect(readFile(outside, "utf8")).resolves.toBe("[]\n");
    },
  );
});

class SwappingWorkspace extends Workspace {
  private swapped = false;

  constructor(
    root: string,
    private readonly swap: (absolutePath: string) => Promise<void>,
  ) {
    super(root);
  }

  override async assertRealPathWithin(absolutePath: string): Promise<void> {
    await super.assertRealPathWithin(absolutePath);

    if (!this.swapped) {
      this.swapped = true;
      await this.swap(absolutePath);
    }
  }
}
