import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/runtime/workspace.js";

describe("Workspace", () => {
  it("rejects lexical path traversal", () => {
    const workspace = new Workspace("/tmp/project");

    expect(() => workspace.resolve("../secret.txt")).toThrow(
      "Path outside workspace",
    );
  });

  it("rejects symlink escape for existing paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));

    const workspace = new Workspace(root);
    const linkedPath = workspace.resolve("link.txt");

    await expect(workspace.assertRealPathWithin(linkedPath)).rejects.toThrow(
      "Real path outside workspace",
    );
  });
});
