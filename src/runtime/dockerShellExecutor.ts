import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { CommandExecutor, CommandResult } from "./commandExecutor.js";
import type { SandboxConfig } from "./sandboxConfig.js";
import type { ShellExecutor, ShellOptions } from "./shellExecutor.js";
import type { Workspace } from "./workspace.js";

interface MountPlan {
  packageRoots: string[];
  maskedFiles: string[];
  maskedDirectories: string[];
}

const activeContainers = new Set<string>();
let exitCleanupInstalled = false;

export class DockerShellExecutor implements ShellExecutor {
  constructor(
    private readonly executor: CommandExecutor,
    private readonly workspace: Workspace,
    private readonly sessionId: string,
    private readonly config: SandboxConfig,
  ) {}

  async runScript(options: ShellOptions): Promise<CommandResult> {
    const relativeCwd = this.workspace.relative(options.cwd);

    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error("Sandbox cwd is outside the workspace.");
    }

    const containerName = createContainerName(this.sessionId);
    const args = await this.buildDockerArgs(
      containerName,
      relativeCwd,
      options.script,
    );
    installExitCleanup();
    activeContainers.add(containerName);

    try {
      const result = await this.executor.run({
        command: "docker",
        args,
        cwd: this.workspace.root,
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars,
      });

      if (result.timedOut) {
        await this.removeContainer(containerName);
      }

      return result;
    } catch (error: unknown) {
      await this.removeContainer(containerName);
      throw error;
    } finally {
      activeContainers.delete(containerName);
    }
  }

  private async buildDockerArgs(
    containerName: string,
    relativeCwd: string,
    script: string,
  ): Promise<string[]> {
    const plan = await this.buildMountPlan();
    const stateRoot = path.join(
      this.workspace.root,
      ".harness",
      "sandbox",
      this.sessionId,
    );
    const depsRoot = path.join(stateRoot, "deps");
    const emptyMask = path.join(stateRoot, "empty-mask");
    const harnessRoot = path.join(this.workspace.root, ".harness");
    const sandboxRoot = path.dirname(stateRoot);
    await ensureDirectory(harnessRoot);
    await ensureDirectory(sandboxRoot);
    await ensureDirectory(stateRoot);
    await ensureDirectory(depsRoot);
    await ensureEmptyFile(emptyMask);

    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--init",
      "--stop-timeout",
      "2",
      "--network",
      this.config.network,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(this.config.pids),
      "--memory",
      this.config.memory,
      "--cpus",
      String(this.config.cpus),
      "--mount",
      mount("bind", this.workspace.root, "/workspace"),
      "--mount",
      "type=tmpfs,dst=/workspace/.harness,tmpfs-size=1048576",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=268435456",
      "--workdir",
      containerPath(relativeCwd),
      "--env",
      "HOME=/tmp/home",
      "--env",
      "LANG=C.UTF-8",
      "--env",
      "CI=1",
    ];

    const gitPath = path.join(this.workspace.root, ".git");
    const gitInfo = await lstat(gitPath).catch(() => null);

    if (gitInfo && !gitInfo.isSymbolicLink()) {
      args.push(
        "--mount",
        `${mount("bind", gitPath, "/workspace/.git")},readonly`,
      );
    }

    for (const [index, packageRoot] of plan.packageRoots.entries()) {
      const source = path.join(depsRoot, String(index));
      await ensureDirectory(source);
      const destination = containerPath(path.join(packageRoot, "node_modules"));
      args.push("--mount", mount("bind", source, destination));
    }

    for (const maskedFile of plan.maskedFiles) {
      args.push(
        "--mount",
        `${mount("bind", emptyMask, containerPath(maskedFile))},readonly`,
      );
    }

    for (const maskedDirectory of plan.maskedDirectories) {
      args.push(
        "--mount",
        `type=tmpfs,dst=${containerPath(maskedDirectory)},tmpfs-size=1048576`,
      );
    }

    args.push(
      this.config.image,
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-lc",
      script,
    );
    return args;
  }

  private async buildMountPlan(): Promise<MountPlan> {
    const packageRoots: string[] = [];
    const maskedFiles: string[] = [];
    const maskedDirectories: string[] = [];
    const remaining = await scanWorkspace(
      this.workspace.root,
      "",
      packageRoots,
      maskedFiles,
      maskedDirectories,
      5_000,
    );

    if (remaining <= 0) {
      throw new Error(
        "Workspace exceeds the 5,000-directory sandbox scan limit.",
      );
    }

    return { packageRoots, maskedFiles, maskedDirectories };
  }

  private async removeContainer(containerName: string): Promise<void> {
    await this.executor.run({
      command: "docker",
      args: ["rm", "--force", containerName],
      cwd: this.workspace.root,
      timeoutMs: 10_000,
      maxOutputChars: 5_000,
    });
  }
}

async function scanWorkspace(
  absoluteDirectory: string,
  relativeDirectory: string,
  packageRoots: string[],
  maskedFiles: string[],
  maskedDirectories: string[],
  remainingDirectories: number,
): Promise<number> {
  if (remainingDirectories <= 0) {
    return 0;
  }

  const entries = await readdir(absoluteDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  const hasPackageJson = entries.some(
    (entry) => entry.isFile() && entry.name === "package.json",
  );

  if (hasPackageJson) {
    packageRoots.push(relativeDirectory);
  }

  for (const entry of entries) {
    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      /^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|\.pypirc$)/i.test(entry.name)
    ) {
      maskedFiles.push(path.join(relativeDirectory, entry.name));
      continue;
    }

    if (
      entry.isDirectory() &&
      [".ssh", ".aws"].includes(entry.name.toLowerCase())
    ) {
      maskedDirectories.push(path.join(relativeDirectory, entry.name));
      continue;
    }

    if (
      !entry.isDirectory() ||
      [".git", ".harness", "node_modules", "dist"].includes(entry.name)
    ) {
      continue;
    }

    remainingDirectories -= 1;

    if (remainingDirectories <= 0) {
      break;
    }

    remainingDirectories = await scanWorkspace(
      path.join(absoluteDirectory, entry.name),
      path.join(relativeDirectory, entry.name),
      packageRoots,
      maskedFiles,
      maskedDirectories,
      remainingDirectories,
    );
  }

  return remainingDirectories;
}

function mount(type: "bind", source: string, destination: string): string {
  if (source.includes(",") || destination.includes(",")) {
    throw new Error("Docker mount paths containing commas are not supported.");
  }

  return `type=${type},src=${source},dst=${destination}`;
}

function containerPath(relativePath: string): string {
  const normalized = relativePath.split(path.sep).filter(Boolean).join("/");
  return normalized ? `/workspace/${normalized}` : "/workspace";
}

function createContainerName(sessionId: string): string {
  const safeSession = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .slice(0, 40);
  return `harness-${safeSession}-${randomBytes(3).toString("hex")}`;
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  try {
    await mkdir(directoryPath);
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }

  const info = await lstat(directoryPath);

  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Sandbox state path is not a safe directory: ${directoryPath}`);
  }
}

async function ensureEmptyFile(filePath: string): Promise<void> {
  try {
    const handle = await open(filePath, "wx", 0o600);
    await handle.close();
    return;
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }

  const info = await lstat(filePath);

  if (info.isSymbolicLink() || !info.isFile() || info.size !== 0) {
    throw new Error(`Sandbox mask is not a safe empty file: ${filePath}`);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function installExitCleanup(): void {
  if (exitCleanupInstalled) {
    return;
  }

  exitCleanupInstalled = true;
  process.once("exit", () => {
    for (const containerName of activeContainers) {
      spawnSync("docker", ["rm", "--force", containerName], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
        timeout: 3_000,
      });
    }
  });
}
