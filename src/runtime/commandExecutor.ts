export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated?: boolean;
}

export interface CommandOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
}

export interface CommandExecutor {
  run(options: CommandOptions): Promise<CommandResult>;
}
