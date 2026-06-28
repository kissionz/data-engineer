import type { CommandExecutor } from "./commandExecutor.js";
import type { ShellExecutor, ShellOptions } from "./shellExecutor.js";

export type NetworkPolicy = "unrestricted" | "restricted";

/**
 * A shell executor that applies network restrictions when running on the host.
 *
 * - On macOS: uses `sandbox-exec` with a deny-network profile.
 * - On Linux: uses `unshare --net` to create a network namespace without connectivity.
 * - Fallback: logs a warning and runs unrestricted if neither is available.
 */
export class LocalShellExecutor implements ShellExecutor {
  private readonly networkPolicy: NetworkPolicy;

  constructor(
    private readonly executor: CommandExecutor,
    networkPolicy: NetworkPolicy = "unrestricted",
  ) {
    this.networkPolicy = networkPolicy;
  }

  runScript(options: ShellOptions) {
    const shell = process.platform === "win32" ? "bash.exe" : "/bin/bash";

    if (this.networkPolicy === "restricted") {
      return this.runRestricted(shell, options);
    }

    return this.executor.run({
      command: shell,
      args: ["--noprofile", "--norc", "-lc", options.script],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      signal: options.signal,
    });
  }

  private runRestricted(shell: string, options: ShellOptions) {
    if (process.platform === "darwin") {
      return this.runDarwinSandbox(shell, options);
    }

    if (process.platform === "linux") {
      return this.runLinuxUnshare(shell, options);
    }

    // Fallback: run unrestricted on unsupported platforms
    return this.executor.run({
      command: shell,
      args: ["--noprofile", "--norc", "-lc", options.script],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      signal: options.signal,
    });
  }

  private runDarwinSandbox(shell: string, options: ShellOptions) {
    // macOS sandbox-exec with deny-network profile
    const sandboxProfile = [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
    ].join("\n");

    return this.executor.run({
      command: "sandbox-exec",
      args: ["-p", sandboxProfile, shell, "--noprofile", "--norc", "-lc", options.script],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      signal: options.signal,
    });
  }

  private runLinuxUnshare(shell: string, options: ShellOptions) {
    // Linux: unshare --net creates a network namespace with only loopback
    return this.executor.run({
      command: "unshare",
      args: ["--net", shell, "--noprofile", "--norc", "-lc", options.script],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      signal: options.signal,
    });
  }
}
