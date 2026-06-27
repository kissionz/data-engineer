import { mkdtemp } from "node:fs/promises";
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
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

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
});

function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-executor-"));
}
