import { describe, expect, it } from "vitest";
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

  it("allows readonly shell commands", () => {
    const gate = new PermissionGate(defaultPolicy());

    for (const command of [
      "pwd",
      "ls -la",
      "rg --files",
      "git status --short",
      "node --version",
    ]) {
      expect(
        gate.check({ id: command, name: "Bash", args: { command } }),
      ).toMatchObject({ decision: "allow" });
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
  });
});
