import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CommandExecutor,
  CommandOptions,
} from "../src/runtime/commandExecutor.js";
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
    const calls: CommandOptions[] = [];
    const executor: CommandExecutor = {
      async run(options) {
        calls.push(options);
        return {
          ok: true,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          timedOut: false,
        };
      },
    };

    const result = await new BashTool(new Workspace(root), executor).execute({
      command: "echo ok",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("ok");
    expect(calls[0]?.cwd).toBe(root);
    expect(calls[0]?.shell).toBe(true);
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
    expect(calls[0]?.shell).toBeUndefined();
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
    expect(calls[0]?.shell).toBeUndefined();
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
    expect(calls[0]?.shell).toBeUndefined();
    expect(calls[1]?.shell).toBeUndefined();
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
});
