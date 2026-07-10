import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyState } from "../src/cli/migrate.js";

describe("Montane state migration", () => {
  it("plans without changing legacy state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-migrate-"));
    await mkdir(path.join(root, ".harness"));
    const results = await migrateLegacyState({
      workspaceRoot: root,
      userHome: root,
      workspace: true,
      user: false,
      dryRun: true,
    });
    expect(results[0]?.status).toBe("planned");
    await expect(lstat(path.join(root, ".harness"))).resolves.toBeDefined();
  });

  it("migrates workspace state and project configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-migrate-"));
    await mkdir(path.join(root, ".harness"));
    await writeFile(path.join(root, ".harness.json"), "{}\n");
    const results = await migrateLegacyState({
      workspaceRoot: root,
      userHome: root,
      workspace: true,
      user: false,
    });
    expect(results.map((result) => result.status)).toEqual([
      "migrated",
      "migrated",
    ]);
    await expect(lstat(path.join(root, ".montane"))).resolves.toBeDefined();
    await expect(lstat(path.join(root, ".montane.json"))).resolves.toBeDefined();
  });

  it("refuses ambiguous migrations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-migrate-"));
    await mkdir(path.join(root, ".harness"));
    await mkdir(path.join(root, ".montane"));
    const results = await migrateLegacyState({
      workspaceRoot: root,
      userHome: root,
      workspace: false,
      user: true,
    });
    expect(results[0]).toMatchObject({ status: "conflict" });
  });
});
