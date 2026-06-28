import type {
  CommandExecutor,
  CommandResult,
} from "./commandExecutor.js";

export interface RuntimeCapabilities {
  git: boolean;
  ripgrep: boolean;
  gitRepository: boolean;
}

export async function discoverRuntimeCapabilities(
  executor: CommandExecutor,
  cwd: string,
): Promise<RuntimeCapabilities> {
  const [gitVersion, ripgrepVersion, repository] = await Promise.all([
    probe(executor, cwd, "git", ["--version"]),
    probe(executor, cwd, "rg", ["--version"]),
    probe(executor, cwd, "git", ["rev-parse", "--is-inside-work-tree"]),
  ]);

  return {
    git: gitVersion.ok,
    ripgrep: ripgrepVersion.ok,
    gitRepository:
      repository.ok && repository.stdout.trim().toLowerCase() === "true",
  };
}

async function probe(
  executor: CommandExecutor,
  cwd: string,
  command: string,
  args: string[],
): Promise<CommandResult> {
  return executor.run({
    command,
    args,
    cwd,
    timeoutMs: 5_000,
    maxOutputChars: 2_000,
  });
}
