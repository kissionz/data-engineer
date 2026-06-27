import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "../src/runtime/commandExecutor.js";
import { DockerAvailabilityChecker } from "../src/runtime/dockerAvailability.js";
import { DockerShellExecutor } from "../src/runtime/dockerShellExecutor.js";
import {
  parseSandboxConfig,
  type SandboxConfig,
} from "../src/runtime/sandboxConfig.js";
import { Workspace } from "../src/runtime/workspace.js";

describe("sandbox config", () => {
  it("parses secure defaults and rejects invalid values", () => {
    expect(parseSandboxConfig({})).toMatchObject({
      mode: "auto",
      image: "node:22-bookworm",
      pull: "never",
      network: "none",
      memory: "1g",
      cpus: 2,
      pids: 256,
    });
    expect(() => parseSandboxConfig({ mode: "unsafe" })).toThrow(
      "--bash-sandbox",
    );
    expect(() => parseSandboxConfig({ memory: "no-limit" })).toThrow(
      "--sandbox-memory",
    );
  });
});

describe("DockerAvailabilityChecker", () => {
  it("verifies daemon, local context, image, and workspace mount", async () => {
    const root = await makeRoot();
    const executor = new ScriptedExecutor([
      ok(JSON.stringify({ Server: { Os: "linux" } })),
      ok(JSON.stringify("unix:///var/run/docker.sock")),
      ok("image"),
      ok("ready"),
    ]);

    await expect(
      new DockerAvailabilityChecker(executor).check(root, config()),
    ).resolves.toEqual({ available: true });

    expect(executor.calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["version", "--format"],
      ["context", "inspect"],
      ["image", "inspect"],
      ["run", "--rm"],
    ]);
  });

  it("rejects unavailable daemons and remote contexts", async () => {
    const root = await makeRoot();
    const unavailable = new ScriptedExecutor([
      failed("Cannot connect to the Docker daemon"),
    ]);
    await expect(
      new DockerAvailabilityChecker(unavailable).check(root, config()),
    ).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("daemon"),
    });

    const remote = new ScriptedExecutor([
      ok(JSON.stringify({ Server: { Os: "linux" } })),
      ok(JSON.stringify("ssh://builder.example")),
    ]);
    await expect(
      new DockerAvailabilityChecker(remote).check(root, config()),
    ).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("Remote Docker"),
    });
  });

  it("pulls a missing image only when explicitly configured", async () => {
    const root = await makeRoot();
    const executor = new ScriptedExecutor([
      ok(JSON.stringify({ Server: { Os: "linux" } })),
      ok(JSON.stringify("unix:///var/run/docker.sock")),
      failed("missing"),
      ok("pulled"),
      ok("ready"),
    ]);

    await expect(
      new DockerAvailabilityChecker(executor).check(
        root,
        config({ pull: "missing" }),
      ),
    ).resolves.toEqual({ available: true });
    expect(executor.calls[3]?.args).toEqual(["pull", "node:22-bookworm"]);
  });
});

describe("DockerShellExecutor", () => {
  it("builds a constrained container command and masks host state", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "package.json"), "{}", "utf8");
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, ".env.local"), "SECRET=value", "utf8");
    await writeFile(path.join(root, ".npmrc"), "//registry/:_authToken=x", "utf8");
    await mkdir(path.join(root, ".ssh"));
    await mkdir(path.join(root, ".git"));
    const executor = new ScriptedExecutor([ok("done")]);
    const shell = new DockerShellExecutor(
      executor,
      new Workspace(root),
      "session-1",
      config(),
    );

    const result = await shell.runScript({
      script: "npm test",
      cwd: root,
      timeoutMs: 5_000,
      maxOutputChars: 1_000,
    });

    expect(result.ok).toBe(true);
    const args = executor.calls[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--workdir",
        "/workspace",
        "node:22-bookworm",
        "/bin/bash",
        "-lc",
        "npm test",
      ]),
    );
    expect(args.join("\n")).toContain("dst=/workspace/.git");
    expect(args.join("\n")).toContain("dst=/workspace/node_modules");
    expect(args.join("\n")).toContain("dst=/workspace/.env.local");
    expect(args.join("\n")).toContain("dst=/workspace/.npmrc");
    expect(args.join("\n")).toContain("dst=/workspace/.ssh");
    expect(args.join("\n")).toContain("dst=/workspace/.harness");
  });

  it("force-removes a container after timeout", async () => {
    const root = await makeRoot();
    const executor = new ScriptedExecutor([
      {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      },
      ok("removed"),
    ]);
    const shell = new DockerShellExecutor(
      executor,
      new Workspace(root),
      "session-2",
      config(),
    );

    await shell.runScript({
      script: "sleep 100",
      cwd: root,
      timeoutMs: 10,
    });

    expect(executor.calls[1]?.args.slice(0, 2)).toEqual(["rm", "--force"]);
  });
});

class ScriptedExecutor implements CommandExecutor {
  readonly calls: CommandOptions[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(options: CommandOptions): Promise<CommandResult> {
    this.calls.push(options);
    const result = this.results.shift();

    if (!result) {
      throw new Error("Unexpected executor call.");
    }

    return result;
  }
}

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    ...parseSandboxConfig({}),
    ...overrides,
  };
}

function ok(stdout: string): CommandResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
  };
}

function failed(stderr: string): CommandResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr,
    timedOut: false,
  };
}

function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-docker-"));
}
