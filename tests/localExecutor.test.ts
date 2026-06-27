import { access, mkdtemp } from "node:fs/promises";
import { getEventListeners } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSafeEnv,
  LocalCommandExecutor,
} from "../src/runtime/localExecutor.js";
import { LocalShellExecutor } from "../src/runtime/localShellExecutor.js";

describe("LocalCommandExecutor", () => {
  it("executes argv without interpreting shell metacharacters", async () => {
    const cwd = await makeRoot();
    const value = "value with spaces; $(not-a-command)";
    const result = await new LocalCommandExecutor().run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", value],
      cwd,
      timeoutMs: 2_000,
    });

    expect(result).toMatchObject({
      ok: true,
      stdout: value,
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
    });
  });

  it("bounds stdout and stderr while retaining their head and tail", async () => {
    const cwd = await makeRoot();
    const result = await new LocalCommandExecutor(128).run({
      command: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write("HEAD" + "a".repeat(1000) + "TAIL");',
          'process.stderr.write("ERRHEAD" + "b".repeat(1000) + "ERRTAIL");',
        ].join(""),
      ],
      cwd,
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stderr.length).toBeLessThanOrEqual(128);
    expect(result.stdout).toContain("HEAD");
    expect(result.stdout).toContain("TAIL");
    expect(result.stderr).toContain("ERRHEAD");
    expect(result.stderr).toContain("ERRTAIL");
  });

  it("terminates timed-out processes before resolving", async () => {
    const cwd = await makeRoot();
    const startedAt = Date.now();
    const result = await new LocalCommandExecutor(1024, 50).run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd,
      timeoutMs: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("does not start a process when its signal is already aborted", async () => {
    const cwd = await makeRoot();
    const controller = new AbortController();
    controller.abort();

    const result = await new LocalCommandExecutor().run({
      command: "this-command-must-not-be-spawned",
      args: [],
      cwd,
      timeoutMs: 2_000,
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
    });
  });

  it.runIf(process.platform !== "win32")(
    "cancels the complete process tree and removes its abort listener",
    async () => {
      const cwd = await makeRoot();
      const readyPath = path.join(cwd, "child-ready");
      const survivedPath = path.join(cwd, "child-survived");
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(survivedPath)}, "survived"), 500);`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const controller = new AbortController();
      const executor = new LocalCommandExecutor(1024, 50);
      const run = executor.run({
        command: process.execPath,
        args: ["-e", parentScript],
        cwd,
        timeoutMs: 5_000,
        signal: controller.signal,
      });

      await waitForFile(readyPath);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort();
      const result = await run;

      expect(result).toMatchObject({
        ok: false,
        timedOut: false,
        cancelled: true,
      });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 650));
      await expect(access(survivedPath)).rejects.toThrow();
    },
  );

  it("preserves platform bootstrap variables and filters arbitrary secrets", () => {
    const env = buildSafeEnv({
      PATH: "path",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD",
      TEMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\test",
      SECRET_TOKEN: "do-not-forward",
    });

    expect(env).toMatchObject({
      PATH: "path",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD",
      TEMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\test",
    });
    expect(env.SECRET_TOKEN).toBeUndefined();
  });
});

describe("LocalShellExecutor", () => {
  it.runIf(process.platform !== "win32")(
    "runs scripts through Bash explicitly",
    async () => {
      const cwd = await makeRoot();
      const result = await new LocalShellExecutor(
        new LocalCommandExecutor(),
      ).runScript({
        script: 'printf "%s" "$((2 + 3))"',
        cwd,
        timeoutMs: 2_000,
      });

      expect(result).toMatchObject({ ok: true, stdout: "5" });
    },
  );

  it("passes cancellation through to the command executor", async () => {
    const cwd = await makeRoot();
    const controller = new AbortController();
    controller.abort();
    const result = await new LocalShellExecutor(
      new LocalCommandExecutor(),
    ).runScript({
      script: "exit 0",
      cwd,
      timeoutMs: 2_000,
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      ok: false,
      timedOut: false,
      cancelled: true,
    });
  });
});

function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-executor-"));
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}
