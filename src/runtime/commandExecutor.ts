export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  cleanupFailed?: boolean;
  outputTruncated?: boolean;
}

export interface CommandProgress {
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface CommandOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
  onProgress?: (progress: CommandProgress) => void;
}

export interface CommandExecutor {
  run(options: CommandOptions): Promise<CommandResult>;
}
