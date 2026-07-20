import type {
  CommandProgress,
  CommandResult,
} from "./commandExecutor.js";

export interface ShellOptions {
  script: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
  onProgress?: (progress: CommandProgress) => void;
}

export interface ShellExecutor {
  runScript(options: ShellOptions): Promise<CommandResult>;
}
