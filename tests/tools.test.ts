import {
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  });

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

  it("creates new files without overwriting existing files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
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
    expect(overwritten.data).toMatchObject({ reason: "file_exists" });
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
    expect(result.data).toMatchObject({ reason: "old_string_not_unique" });
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
