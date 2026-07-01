import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "./commandExecutor.js";

const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
const TRUNCATION_MARKER = "\n...[output truncated]...\n";
const TASKKILL_TIMEOUT_MS = 5_000;
const activeChildren = new Set<ChildProcess>();
let exitCleanupInstalled = false;

export class LocalCommandExecutor implements CommandExecutor {
  constructor(
    private readonly defaultMaxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    private readonly killGraceMs = 1_000,
  ) {}

  async run(options: CommandOptions): Promise<CommandResult> {
    if (options.signal?.aborted) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: true,
        outputTruncated: false,
      };
    }

    return new Promise((resolve) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        shell: false,
        detached: process.platform !== "win32",
        env: buildSafeEnv(),
        windowsHide: true,
      });
      installExitCleanup();
      activeChildren.add(child);
      const maxOutputChars = normalizeOutputLimit(
        options.maxOutputChars,
        this.defaultMaxOutputChars,
      );
      const stdout = new BoundedText(maxOutputChars);
      const stderr = new BoundedText(maxOutputChars);
      let terminationCause: "timeout" | "cancelled" | undefined;
      let spawnError: Error | undefined;
      let settled = false;
      let childClosed = false;
      let closeCode: number | null = null;
      let forceKillSent = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const requestTermination = (cause: "timeout" | "cancelled") => {
        if (settled || terminationCause) {
          return;
        }

        terminationCause = cause;
        void terminateProcessTree(child, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          void terminateProcessTree(child, "SIGKILL").then(() => {
            forceKillSent = true;

            if (childClosed) {
              finish(closeCode);
            }
          });
        }, this.killGraceMs);
      };

      const onAbort = () => requestTermination("cancelled");

      const finish = (exitCode: number | null) => {
        if (settled) {
          return;
        }

        settled = true;
        activeChildren.delete(child);

        clearTimeout(timeout);

        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }

        options.signal?.removeEventListener("abort", onAbort);
        stdout.end();
        stderr.end();

        if (spawnError) {
          stderr.append(spawnError.message);
        }

        resolve({
          ok: !terminationCause && !spawnError && exitCode === 0,
          exitCode,
          stdout: stdout.value(),
          stderr: stderr.value(),
          timedOut: terminationCause === "timeout",
          cancelled: terminationCause === "cancelled",
          outputTruncated: stdout.truncated || stderr.truncated,
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => stdout.appendBuffer(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.appendBuffer(chunk));
      child.on("error", (error) => {
        spawnError = error;
      });
      child.on("close", (code) => {
        childClosed = true;
        closeCode = code;

        if (!terminationCause || forceKillSent) {
          finish(code);
        }
      });

      const timeout = setTimeout(
        () => requestTermination("timeout"),
        Math.max(1, options.timeoutMs),
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });

      if (options.signal?.aborted) {
        onAbort();
      }
    });
  }
}

export function buildSafeEnv(source = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "USER",
    "TMPDIR",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ];

  for (const key of keys) {
    if (source[key]) {
      env[key] = source[key];
    }
  }

  return env;
}

class BoundedText {
  private readonly decoder = new StringDecoder("utf8");
  private full: string | null = "";
  private head = "";
  private tail = "";
  private readonly headLimit: number;
  private readonly tailLimit: number;
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
    const contentLimit = Math.max(0, limit - TRUNCATION_MARKER.length);
    this.headLimit = Math.ceil(contentLimit / 2);
    this.tailLimit = Math.floor(contentLimit / 2);
  }

  get truncated(): boolean {
    return this.full === null;
  }

  appendBuffer(chunk: Buffer): void {
    this.append(this.decoder.write(chunk));
  }

  append(text: string): void {
    if (!text) {
      return;
    }

    if (this.full !== null) {
      const combined = `${this.full}${text}`;

      if (combined.length <= this.limit) {
        this.full = combined;
        return;
      }

      this.head = combined.slice(0, this.headLimit);
      this.tail =
        this.tailLimit > 0 ? combined.slice(-this.tailLimit) : "";
      this.full = null;
      return;
    }

    if (this.tailLimit > 0) {
      this.tail = `${this.tail}${text}`.slice(-this.tailLimit);
    }
  }

  end(): void {
    this.append(this.decoder.end());
  }

  value(): string {
    if (this.full !== null) {
      return this.full;
    }

    if (this.limit <= TRUNCATION_MARKER.length) {
      return this.tail.slice(-this.limit);
    }

    return `${this.head}${TRUNCATION_MARKER}${this.tail}`;
  }
}

function normalizeOutputLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(64, Math.floor(value));
}

function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!child.pid) {
    return Promise.resolve();
  }

  try {
    if (process.platform === "win32") {
      const args = ["/pid", String(child.pid), "/t"];

      if (signal === "SIGKILL") {
        args.push("/f");
      }

      return new Promise((resolve) => {
        const killer = spawn("taskkill.exe", args, {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          try {
            killer.kill("SIGKILL");
          } catch {
            // The taskkill process already exited.
          }
          finish();
        }, TASKKILL_TIMEOUT_MS);
        killer.once("error", finish);
        killer.once("close", finish);
      });
    }

    process.kill(-child.pid, signal);
    return Promise.resolve();
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
    return Promise.resolve();
  }
}

function installExitCleanup(): void {
  if (exitCleanupInstalled) {
    return;
  }

  exitCleanupInstalled = true;
  process.once("exit", () => {
    for (const child of activeChildren) {
      forceKillProcessTreeSync(child);
    }
  });
}

function forceKillProcessTreeSync(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      spawnSync(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
          timeout: 3_000,
        },
      );
      return;
    }

    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}
