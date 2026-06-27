import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandExecutor } from "./commandExecutor.js";

export interface WorktreeInfo {
  id: string;
  repositoryRoot: string;
  path: string;
  branch: string;
  baseRef: string;
}

export class WorktreeManager {
  constructor(
    private readonly executor: CommandExecutor,
    private readonly requestedCwd: string,
    private readonly configuredWorktreesRoot?: string,
  ) {}

  async create(baseRef = "HEAD"): Promise<WorktreeInfo> {
    if (!baseRef.trim()) {
      throw new Error("Worktree base ref cannot be empty.");
    }

    const repositoryRoot = await this.findRepositoryRoot();
    await this.assertClean(repositoryRoot);
    const baseCommit = await this.resolveBaseCommit(repositoryRoot, baseRef);
    const worktreesRoot =
      this.configuredWorktreesRoot ??
      path.join(
        path.dirname(repositoryRoot),
        `${path.basename(repositoryRoot)}-harness-worktrees`,
      );
    await ensureSafeDirectory(worktreesRoot);

    const id = createWorktreeId();
    const worktreePath = path.join(worktreesRoot, id);
    const branch = `harness/${id}`;
    const existing = await lstat(worktreePath).catch(() => null);

    if (existing) {
      throw new Error(`Worktree path already exists: ${worktreePath}`);
    }

    const result = await this.executor.run({
      command: "git",
      args: [
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        baseCommit,
      ],
      cwd: repositoryRoot,
      timeoutMs: 60_000,
      maxOutputChars: 20_000,
    });

    if (!result.ok) {
      throw new Error(
        `Unable to create git worktree: ${
          result.stderr || result.stdout || "unknown git error"
        }`,
      );
    }

    return {
      id,
      repositoryRoot,
      path: worktreePath,
      branch,
      baseRef,
    };
  }

  private async findRepositoryRoot(): Promise<string> {
    const result = await this.executor.run({
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: this.requestedCwd,
      timeoutMs: 10_000,
      maxOutputChars: 5_000,
    });

    if (!result.ok || !result.stdout.trim()) {
      throw new Error(
        `Worktree mode requires a git repository: ${
          result.stderr || "repository root not found"
        }`,
      );
    }

    return realpath(result.stdout.trim());
  }

  private async assertClean(repositoryRoot: string): Promise<void> {
    const result = await this.executor.run({
      command: "git",
      args: ["status", "--porcelain", "--untracked-files=normal"],
      cwd: repositoryRoot,
      timeoutMs: 20_000,
      maxOutputChars: 20_000,
    });

    if (!result.ok) {
      throw new Error(
        `Unable to inspect repository status: ${result.stderr || result.stdout}`,
      );
    }

    if (result.stdout.trim()) {
      throw new Error(
        "Worktree mode requires a clean repository so the isolated task cannot silently omit local changes.",
      );
    }
  }

  private async resolveBaseCommit(
    repositoryRoot: string,
    baseRef: string,
  ): Promise<string> {
    if (/[\0\r\n]/.test(baseRef) || baseRef.startsWith("-")) {
      throw new Error(`Invalid worktree base ref: ${baseRef}`);
    }

    const result = await this.executor.run({
      command: "git",
      args: ["rev-parse", "--verify", `${baseRef}^{commit}`],
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      maxOutputChars: 5_000,
    });
    const commit = result.stdout.trim();

    if (!result.ok || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new Error(
        `Unable to resolve worktree base ref ${baseRef}: ${
          result.stderr || result.stdout || "commit not found"
        }`,
      );
    }

    return commit;
  }
}

async function ensureSafeDirectory(directoryPath: string): Promise<void> {
  try {
    await mkdir(directoryPath, { recursive: true });
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }

  const info = await lstat(directoryPath);

  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Worktrees root is not a safe directory: ${directoryPath}`);
  }
}

function createWorktreeId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "-");
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
