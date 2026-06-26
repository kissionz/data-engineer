export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandExecutor {
  run(options: {
    command: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<CommandResult>;
}
