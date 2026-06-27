import type { CommandResult } from "./commandExecutor.js";

export interface ShellOptions {
  script: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
}

export interface ShellExecutor {
  runScript(options: ShellOptions): Promise<CommandResult>;
}
