import type { CommandExecutor } from "./commandExecutor.js";
import type { ShellExecutor, ShellOptions } from "./shellExecutor.js";

export type NetworkPolicy = "unrestricted" | "restricted";

/**
 * A shell executor that applies network restrictions when running on the host.
 *
 * - On macOS: uses `sandbox-exec` with a deny-network profile.
 * - On Linux: uses `unshare --net` to create a network namespace without connectivity.
 * - Other platforms: fails closed without running the command.
 */
export class LocalShellExecutor implements ShellExecutor {
  private readonly networkPolicy: NetworkPolicy;

  constructor(
    private readonly executor: CommandExecutor,
    networkPolicy: NetworkPolicy = "unrestricted",
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.networkPolicy = networkPolicy;
  }

  runScript(options: ShellOptions) {
    const shell = this.platform === "win32" ? "bash.exe" : "/bin/bash";

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
    if (this.platform === "darwin") {
      return this.runDarwinSandbox(shell, options);
    }

    if (this.platform === "linux") {
      return this.runLinuxUnshare(shell, options);
    }

    return Promise.resolve({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr:
        `Network-restricted host execution is unsupported on ${this.platform}; ` +
        "the command was not run.",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
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
