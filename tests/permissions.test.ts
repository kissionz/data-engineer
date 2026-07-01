import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { FolderGrantManager } from "../src/permissions/folderGrants.js";
import { PermissionGate } from "../src/permissions/gate.js";
import { defaultPolicy } from "../src/permissions/policy.js";

describe("PermissionGate", () => {
  it("allows readonly reads", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({ id: "1", name: "Read", args: { file_path: "README.md" } }),
    ).toMatchObject({ decision: "allow" });
  });

  it("allows readonly grep searches", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({ id: "1", name: "Grep", args: { pattern: "AgentLoop" } }),
    ).toMatchObject({ decision: "allow" });
  });

  it("allows low-risk discovery and task-state tools", () => {
    const gate = new PermissionGate(defaultPolicy());

    for (const name of [
      "Glob",
      "ListDirectory",
      "GitStatus",
      "GitDiff",
      "TodoRead",
      "TodoWrite",
      "SkillList",
      "SkillLoad",
      "Task",
    ]) {
      expect(gate.check({ id: name, name, args: {} })).toMatchObject({
        decision: "allow",
      });
    }
  });

  it("allows creating new files through the create-only Write tool", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({
        id: "1",
        name: "Write",
        args: { file_path: "new.txt", content: "hello" },
      }),
    ).toMatchObject({ decision: "allow" });
  });

  it("asks before editing files", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({
        id: "1",
        name: "Edit",
        args: {
          file_path: "README.md",
          old_string: "a",
          new_string: "b",
        },
      }),
    ).toMatchObject({ decision: "ask" });
  });

  it("asks before accessing a path outside the workspace", () => {
    const root = path.resolve("/workspace/project");
    const gate = new PermissionGate(defaultPolicy(), root);

    for (const call of [
      {
        id: "read",
        name: "Read",
        args: { file_path: "../shared/config.json" },
      },
      {
        id: "glob",
        name: "Glob",
        args: { path: "/workspace/shared", pattern: "**/*" },
      },
      {
        id: "bash",
        name: "Bash",
        args: { command: "pwd", cwd: "../shared" },
      },
    ]) {
      expect(gate.check(call)).toMatchObject({
        decision: "ask",
      });
      expect(gate.check(call).reason).toContain(
        "Access outside the workspace requires approval",
      );
    }
  });

  it("still denies sensitive paths outside the workspace", () => {
    const gate = new PermissionGate(
      defaultPolicy(),
      path.resolve("/workspace/project"),
    );

    expect(
      gate.check({
        id: "1",
        name: "Read",
        args: { file_path: "../shared/.env.production" },
      }),
    ).toMatchObject({ decision: "deny" });
  });

  it("reuses recursive folder grants for matching access only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-workspace-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-shared-"));
    const grants = await FolderGrantManager.load(
      path.join(root, "folder-grants.json"),
    );
    const gate = new PermissionGate(defaultPolicy(), root, grants);
    const first = gate.check({
      id: "1",
      name: "Read",
      args: { file_path: path.join(outside, "first.txt") },
    });

    expect(first).toMatchObject({
      decision: "ask",
      folderGrant: { folder: outside, access: "read" },
    });
    await gate.grantFolder(first.folderGrant!, "session");

    expect(
      gate.check({
        id: "2",
        name: "Read",
        args: { file_path: path.join(outside, "nested", "second.txt") },
      }),
    ).toMatchObject({ decision: "allow" });
    expect(
      gate.check({
        id: "3",
        name: "Edit",
        args: {
          file_path: path.join(outside, "nested", "second.txt"),
          old_string: "a",
          new_string: "b",
        },
      }),
    ).toMatchObject({ decision: "ask" });
    expect(
      gate.check({
        id: "4",
        name: "Read",
        args: {
          file_path: path.join(`${outside}-sibling`, "third.txt"),
        },
      }),
    ).toMatchObject({ decision: "ask" });
  });

  it("asks before every shell command because shell syntax is not safely classifiable", () => {
    const gate = new PermissionGate(defaultPolicy());

    for (const command of [
      "pwd",
      "ls -la",
      "rg --files",
      "git status --short",
      "node --version",
      "cat $(touch pwned)",
      "git status\ntouch pwned",
      "cat `touch pwned`",
      "rg x --glob=$(touch pwned)",
    ]) {
      expect(
        gate.check({ id: command, name: "Bash", args: { command } }),
      ).toMatchObject({ decision: "ask" });
    }
  });

  it("asks before shell commands that may change state", () => {
    const gate = new PermissionGate(defaultPolicy());

    for (const command of [
      "npm test",
      "git checkout main",
      "git diff --output=changes.patch",
      "echo hello > output.txt",
      "cat input.txt | grep value",
    ]) {
      expect(
        gate.check({ id: command, name: "Bash", args: { command } }),
      ).toMatchObject({ decision: "ask" });
    }
  });

  it("uses configured denied path prefixes instead of hard-coded names", () => {
    const policy = defaultPolicy();
    policy.deniedPathPrefixes = ["private/cache"];
    const gate = new PermissionGate(policy);

    expect(
      gate.check({
        id: "custom-denied",
        name: "Read",
        args: { file_path: "nested/private/cache/token.txt" },
      }),
    ).toMatchObject({ decision: "deny" });
    expect(
      gate.check({
        id: "formerly-denied",
        name: "Read",
        args: { file_path: ".git/config" },
      }),
    ).toMatchObject({ decision: "allow" });
  });

  it("denies dangerous shell commands", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({ id: "1", name: "Bash", args: { command: "rm -rf ." } }),
    ).toMatchObject({ decision: "deny" });
  });

  it("denies policy paths", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({ id: "1", name: "Read", args: { file_path: ".git/config" } }),
    ).toMatchObject({ decision: "deny" });

    expect(
      gate.check({
        id: "2",
        name: "Read",
        args: { file_path: "packages/app/.env.local" },
      }),
    ).toMatchObject({ decision: "deny" });

    expect(
      gate.check({
        id: "3",
        name: "Bash",
        args: { command: "cat packages/app/.env.local" },
      }),
    ).toMatchObject({ decision: "deny" });

    expect(
      gate.check({
        id: "4",
        name: "Bash",
        args: { command: "rg token node_modules/package/index.js" },
      }),
    ).toMatchObject({ decision: "deny" });

    expect(
      gate.check({
        id: "5",
        name: "Bash",
        args: { command: "cat config", cwd: ".GIT", file_path: "safe" },
      }),
    ).toMatchObject({ decision: "deny" });

    expect(
      gate.check({
        id: "6",
        name: "Edit",
        args: {
          file_path: "/home/user/.harness/permissions/folder-grants.json",
          old_string: "read",
          new_string: "read_write",
        },
      }),
    ).toMatchObject({ decision: "deny" });

    expect(
      gate.check({
        id: "7",
        name: "Bash",
        args: {
          command: "cat ~/.harness/permissions/folder-grants.json",
        },
      }),
    ).toMatchObject({ decision: "deny" });
  });
});
