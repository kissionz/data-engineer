import { describe, expect, it } from "vitest";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "../src/runtime/commandExecutor.js";
import {
  inspectWorktrees,
  parseWorktreePorcelain,
} from "../src/runtime/worktreeReport.js";

describe("readonly worktree report", () => {
  it("parses NUL-delimited porcelain without losing spaces", () => {
    const head = "a".repeat(40);
    expect(
      parseWorktreePorcelain(
        [
          "worktree /repo with spaces",
          `HEAD ${head}`,
          "branch refs/heads/main",
          "",
          "worktree /detached",
          `HEAD ${"b".repeat(40)}`,
          "detached",
          "locked maintenance",
          "",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      {
        path: "/repo with spaces",
        head,
        branch: "main",
        detached: false,
        bare: false,
      },
      {
        path: "/detached",
        head: "b".repeat(40),
        detached: true,
        bare: false,
        locked: "maintenance",
      },
    ]);
  });

  it("uses only no-optional-locks list/status commands and aggregates changes", async () => {
    const head = "c".repeat(40);
    const executor = new ScriptedExecutor([
      ok(
        [
          "worktree /repo/main",
          `HEAD ${head}`,
          "branch refs/heads/main",
          "",
          "",
        ].join("\0"),
      ),
      ok(" M src/a.ts\n?? notes.txt\n"),
    ]);

    await expect(inspectWorktrees(executor, "/repo/main")).resolves.toEqual([
      {
        path: "/repo/main",
        head,
        branch: "main",
        detached: false,
        bare: false,
        clean: false,
        changeCount: 2,
      },
    ]);
    expect(executor.calls.map(({ command, args }) => [command, ...args])).toEqual([
      [
        "git",
        "--no-optional-locks",
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ],
      [
        "git",
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ],
    ]);
  });

  it("does not inspect a missing prunable worktree", async () => {
    const executor = new ScriptedExecutor([
      ok(
        [
          "worktree /missing",
          `HEAD ${"d".repeat(40)}`,
          "prunable gitdir file points to non-existent location",
          "",
          "",
        ].join("\0"),
      ),
    ]);

    const report = await inspectWorktrees(executor, "/repo");

    expect(report[0]).toMatchObject({
      path: "/missing",
      prunable: "gitdir file points to non-existent location",
    });
    expect(executor.calls).toHaveLength(1);
  });

  it("fails closed on truncated Git output", async () => {
    const executor = new ScriptedExecutor([
      { ...ok("partial"), outputTruncated: true },
    ]);

    await expect(inspectWorktrees(executor, "/repo")).rejects.toThrow(
      "Unable to list worktrees",
    );
  });
});

class ScriptedExecutor implements CommandExecutor {
  readonly calls: CommandOptions[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(options: CommandOptions): Promise<CommandResult> {
    this.calls.push(options);
    const result = this.results.shift();
    if (!result) {
      throw new Error("Unexpected command.");
    }
    return result;
  }
}

function ok(stdout: string): CommandResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    cancelled: false,
  };
}
