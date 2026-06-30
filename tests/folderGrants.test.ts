import {
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FolderGrantManager } from "../src/permissions/folderGrants.js";

describe("FolderGrantManager", () => {
  it("applies session grants recursively without matching sibling prefixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-grants-"));
    const manager = await FolderGrantManager.load(path.join(root, "grants.json"));
    const folder = path.join(root, "shared");

    await manager.grant({ folder, access: "read" }, "session");

    expect(
      manager.allows({
        folder: path.join(folder, "nested"),
        access: "read",
      }),
    ).toBe(true);
    expect(
      manager.allows({
        folder: path.join(folder, "nested"),
        access: "read_write",
      }),
    ).toBe(false);
    expect(
      manager.allows({
        folder: path.join(root, "shared-copy"),
        access: "read",
      }),
    ).toBe(false);
  });

  it("persists always grants across manager instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-grants-"));
    const storePath = path.join(root, "permissions", "grants.json");
    const folder = path.join(root, "shared");
    const first = await FolderGrantManager.load(storePath);

    await first.grant({ folder, access: "read_write" }, "always");
    const second = await FolderGrantManager.load(storePath);

    expect(
      second.allows({
        folder: path.join(folder, "nested"),
        access: "read",
      }),
    ).toBe(true);
    expect(
      second.allows({
        folder: path.join(folder, "nested"),
        access: "read_write",
      }),
    ).toBe(true);
    expect(JSON.parse(await readFile(storePath, "utf8"))).toMatchObject({
      version: 1,
      grants: [{ folder, access: "read_write" }],
    });
  });

  it.runIf(process.platform !== "win32")(
    "refuses a symlinked persistent grant store",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-grants-"));
      const target = path.join(root, "target.json");
      const storePath = path.join(root, "grants.json");
      await writeFile(target, '{"version":1,"grants":[]}\n', "utf8");
      await symlink(target, storePath);

      await expect(FolderGrantManager.load(storePath)).rejects.toThrow(
        "symbolic link",
      );
    },
  );
});
