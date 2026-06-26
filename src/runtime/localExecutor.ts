import { spawn } from "node:child_process";
import type { CommandExecutor, CommandResult } from "./commandExecutor.js";

export class LocalCommandExecutor implements CommandExecutor {
  async run(options: {
    command: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(options.command, {
        cwd: options.cwd,
        shell: true,
        detached: process.platform !== "win32",
        env: safeEnv(),
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;

        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          child.kill("SIGKILL");
        }

        resolve({
          ok: false,
          exitCode: null,
          stdout,
          stderr,
          timedOut: true,
        });
      }, options.timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        resolve({
          ok: false,
          exitCode: null,
          stdout,
          stderr: stderr ? `${stderr}\n${error.message}` : error.message,
          timedOut: false,
        });
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        resolve({
          ok: code === 0,
          exitCode: code,
          stdout,
          stderr,
          timedOut: false,
        });
      });
    });
  }
}

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "SHELL", "USER", "TMPDIR"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  return env;
}
