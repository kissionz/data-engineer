import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "./commandExecutor.js";

const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
const TRUNCATION_MARKER = "\n...[output truncated]...\n";

export class LocalCommandExecutor implements CommandExecutor {
  constructor(
    private readonly defaultMaxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    private readonly killGraceMs = 1_000,
  ) {}

  async run(options: CommandOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        shell: false,
        detached: process.platform !== "win32",
        env: buildSafeEnv(),
        windowsHide: true,
      });
      const maxOutputChars = normalizeOutputLimit(
        options.maxOutputChars,
        this.defaultMaxOutputChars,
      );
      const stdout = new BoundedText(maxOutputChars);
      const stderr = new BoundedText(maxOutputChars);
      let timedOut = false;
      let spawnError: Error | undefined;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let forceFinishTimer: NodeJS.Timeout | undefined;

      const timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          terminateProcessTree(child, "SIGKILL");
          forceFinishTimer = setTimeout(() => finish(null), this.killGraceMs);
        }, this.killGraceMs);
      }, Math.max(1, options.timeoutMs));

      const finish = (exitCode: number | null) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }

        if (forceFinishTimer) {
          clearTimeout(forceFinishTimer);
        }

        stdout.end();
        stderr.end();

        if (spawnError) {
          stderr.append(spawnError.message);
        }

        resolve({
          ok: !timedOut && !spawnError && exitCode === 0,
          exitCode,
          stdout: stdout.value(),
          stderr: stderr.value(),
          timedOut,
          outputTruncated: stdout.truncated || stderr.truncated,
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => stdout.appendBuffer(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.appendBuffer(chunk));
      child.on("error", (error) => {
        spawnError = error;
      });
      child.on("close", (code) => finish(code));
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
): void {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      const args = ["/pid", String(child.pid), "/t"];

      if (signal === "SIGKILL") {
        args.push("/f");
      }

      const killer = spawn("taskkill.exe", args, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
      return;
    }

    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}
