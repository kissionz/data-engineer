import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandExecutor } from "../src/runtime/commandExecutor.js";
import { Workspace } from "../src/runtime/workspace.js";
import { BashTool } from "../src/tools/bash.js";
import { EditTool } from "../src/tools/edit.js";
import { GrepTool } from "../src/tools/grep.js";
import { ReadTool } from "../src/tools/read.js";
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
    const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
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
  });

  it("runs grep through ripgrep with workspace constrained path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
    const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
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
    expect(calls[0]?.command).toContain("rg --line-number");
  });
});
