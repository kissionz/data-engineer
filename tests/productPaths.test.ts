import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  stateDirectoryLabel,
  workspaceStateRoot,
} from "../src/runtime/productPaths.js";

describe("Montane product paths", () => {
  it("uses .montane for new workspaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-paths-"));
    expect(workspaceStateRoot(root)).toBe(path.join(root, ".montane"));
    expect(stateDirectoryLabel(workspaceStateRoot(root))).toBe(".montane");
  });

  it("continues legacy state until the user explicitly migrates it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-paths-"));
    await mkdir(path.join(root, ".harness"));
    expect(workspaceStateRoot(root)).toBe(path.join(root, ".harness"));
    expect(stateDirectoryLabel(workspaceStateRoot(root))).toBe(".harness");
  });

  it("prefers Montane state if both paths exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-paths-"));
    await mkdir(path.join(root, ".harness"));
    await mkdir(path.join(root, ".montane"));
    expect(workspaceStateRoot(root)).toBe(path.join(root, ".montane"));
  });
});
