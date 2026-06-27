import type { CommandExecutor } from "./commandExecutor.js";
import type { ShellExecutor, ShellOptions } from "./shellExecutor.js";

export class LocalShellExecutor implements ShellExecutor {
  constructor(private readonly executor: CommandExecutor) {}

  runScript(options: ShellOptions) {
    return this.executor.run({
      command: process.platform === "win32" ? "bash.exe" : "/bin/bash",
      args: ["--noprofile", "--norc", "-lc", options.script],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
    });
  }
}
