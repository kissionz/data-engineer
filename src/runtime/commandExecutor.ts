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

export interface CommandOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
}

export interface CommandExecutor {
  run(options: CommandOptions): Promise<CommandResult>;
}
