import { mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "../src/runtime/commandExecutor.js";
import { LocalCommandExecutor } from "../src/runtime/localExecutor.js";
import { WorktreeManager } from "../src/runtime/worktree.js";

describe("WorktreeManager", () => {
  it("creates a branch and worktree using argv git commands", async () => {
    const repositoryRoot = await makeRoot("harness-worktree-source-");
    const worktreesRoot = await makeRoot("harness-worktree-targets-");
    const executor = new ScriptedExecutor([
      ok(`${repositoryRoot}\n`),
      ok(""),
      ok(`${"a".repeat(40)}\n`),
      ok("Preparing worktree"),
    ]);

    const info = await new WorktreeManager(
      executor,
      repositoryRoot,
      worktreesRoot,
    ).create("main");
    const canonicalRepositoryRoot = await realpath(repositoryRoot);

    expect(info).toMatchObject({
      repositoryRoot: canonicalRepositoryRoot,
      baseRef: "main",
      branch: expect.stringMatching(/^harness\//),
      path: expect.stringMatching(
        new RegExp(`^${escapeRegExp(worktreesRoot)}${escapeRegExp(path.sep)}`),
      ),
    });
    expect(executor.calls[3]).toMatchObject({
      command: "git",
      args: [
        "worktree",
        "add",
        "-b",
        info.branch,
        info.path,
        "a".repeat(40),
      ],
      cwd: canonicalRepositoryRoot,
    });
  });

  it("rejects a dirty source repository", async () => {
    const repositoryRoot = await makeRoot("harness-worktree-source-");
    const executor = new ScriptedExecutor([
      ok(`${repositoryRoot}\n`),
      ok(" M src/index.ts\n"),
    ]);

    await expect(
      new WorktreeManager(executor, repositoryRoot).create(),
    ).rejects.toThrow("requires a clean repository");
    expect(executor.calls).toHaveLength(2);
  });

  it("rejects option-like or unresolved base refs", async () => {
    const repositoryRoot = await makeRoot("harness-worktree-source-");
    const optionExecutor = new ScriptedExecutor([
      ok(`${repositoryRoot}\n`),
      ok(""),
    ]);
    await expect(
      new WorktreeManager(optionExecutor, repositoryRoot).create("--help"),
    ).rejects.toThrow("Invalid worktree base ref");

    const unresolvedExecutor = new ScriptedExecutor([
      ok(`${repositoryRoot}\n`),
      ok(""),
      failed("unknown revision"),
    ]);
    await expect(
      new WorktreeManager(unresolvedExecutor, repositoryRoot).create("missing"),
    ).rejects.toThrow("Unable to resolve worktree base ref");
  });

  it("creates a usable real git worktree", async () => {
    const repositoryRoot = await makeRoot("harness-worktree-repo-");
    const worktreesRoot = await makeRoot("harness-worktree-real-");
    const executor = new LocalCommandExecutor();
    await git(executor, repositoryRoot, ["init"]);
    await git(executor, repositoryRoot, ["config", "user.email", "test@example.com"]);
    await git(executor, repositoryRoot, ["config", "user.name", "Harness Test"]);
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path.join(repositoryRoot, "README.md"), "hello\n", "utf8"),
    );
    await git(executor, repositoryRoot, ["add", "README.md"]);
    await git(executor, repositoryRoot, ["commit", "-m", "initial"]);

    const info = await new WorktreeManager(
      executor,
      repositoryRoot,
      worktreesRoot,
    ).create("HEAD");

    try {
      await expect(readFile(path.join(info.path, "README.md"), "utf8")).resolves.toBe(
        "hello\n",
      );
      const branch = await git(executor, info.path, [
        "branch",
        "--show-current",
      ]);
      expect(branch.stdout.trim()).toBe(info.branch);
    } finally {
      await git(executor, repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        info.path,
      ]);
      await git(executor, repositoryRoot, ["branch", "-D", info.branch]);
    }
  });
});

class ScriptedExecutor implements CommandExecutor {
  readonly calls: CommandOptions[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(options: CommandOptions): Promise<CommandResult> {
    this.calls.push(options);
    const result = this.results.shift();

    if (!result) {
      throw new Error("Unexpected executor call.");
    }

    return result;
  }
}

async function git(
  executor: CommandExecutor,
  cwd: string,
  args: string[],
): Promise<CommandResult> {
  const result = await executor.run({
    command: "git",
    args,
    cwd,
    timeoutMs: 20_000,
  });

  if (!result.ok) {
    throw new Error(result.stderr || result.stdout);
  }

  return result;
}

function ok(stdout: string): CommandResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
  };
}

function failed(stderr: string): CommandResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr,
    timedOut: false,
  };
}

function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
