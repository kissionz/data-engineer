export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandOptions {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  shell?: boolean;
}

export interface CommandExecutor {
  run(options: CommandOptions): Promise<CommandResult>;
}
