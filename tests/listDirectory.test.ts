import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/runtime/workspace.js";
import { ListDirectoryTool } from "../src/tools/listDirectory.js";

describe("ListDirectoryTool", () => {
  it("lists immediate entries while hiding sensitive paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-list-"));
    await mkdir(path.join(root, "nested"));
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "visible.txt"), "visible", "utf8");
    await writeFile(
      path.join(root, "nested", "child.txt"),
      "child",
      "utf8",
    );
    await writeFile(path.join(root, ".env.local"), "secret", "utf8");

    const result = await new ListDirectoryTool(new Workspace(root)).execute({
      max_depth: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[D] nested");
    expect(result.content).toContain("[F] visible.txt");
    expect(result.content).toContain(
      `${path.join("nested", "child.txt")}`,
    );
    expect(result.content).not.toContain(".git");
    expect(result.content).not.toContain("node_modules");
    expect(result.content).not.toContain(".env.local");
  });

  it("lists one level by default and expands only when max_depth requests it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-list-"));
    await mkdir(path.join(root, "first", "second"), { recursive: true });
    await writeFile(
      path.join(root, "first", "second", "deep.txt"),
      "deep",
      "utf8",
    );
    const tool = new ListDirectoryTool(new Workspace(root));

    const shallow = await tool.execute({});
    const recursive = await tool.execute({ max_depth: 3 });

    expect(shallow.content).toContain("[D] first");
    expect(shallow.content).not.toContain("deep.txt");
    expect(recursive.content).toContain("deep.txt");
    expect(shallow.data?.maxDepth).toBe(1);
    expect(recursive.data?.maxDepth).toBe(3);
  });

  it("lists an approved external directory with reusable absolute paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-list-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-external-"));
    const filePath = path.join(outside, "visible.txt");
    await writeFile(filePath, "visible", "utf8");
    const tool = new ListDirectoryTool(new Workspace(root));

    await expect(tool.execute({ path: outside })).rejects.toThrow(
      "Path outside workspace",
    );
    const approved = await tool.execute(
      { path: outside },
      {
        toolCallId: "approved-directory",
        userApproved: true,
        approvedFolder: outside,
      },
    );

    expect(approved.ok).toBe(true);
    expect(approved.content).toContain(`[F] ${filePath}`);
    expect(approved.data).toMatchObject({
      path: outside,
      entries: [{ name: "visible.txt", path: filePath, type: "file" }],
    });
  });
});
