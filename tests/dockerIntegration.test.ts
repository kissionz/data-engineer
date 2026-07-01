import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalCommandExecutor } from "../src/runtime/localExecutor.js";
import { DockerShellExecutor } from "../src/runtime/dockerShellExecutor.js";
import { parseSandboxConfig } from "../src/runtime/sandboxConfig.js";
import { Workspace } from "../src/runtime/workspace.js";

const image = process.env.HARNESS_SANDBOX_IMAGE ?? "node:22-bookworm";
const dockerProbeTimeoutMs = 5_000;
const dockerReady =
  spawnSync("docker", ["info"], {
    stdio: "ignore",
    timeout: dockerProbeTimeoutMs,
  }).status === 0 &&
  spawnSync("docker", ["image", "inspect", image], {
    stdio: "ignore",
    timeout: dockerProbeTimeoutMs,
  }).status === 0;

describe("Docker sandbox integration", () => {
  it.runIf(dockerReady)(
    "runs in a real container with masked secrets and read-only host dependencies",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "harness-docker-integration-"),
      );
      await writeFile(path.join(root, "package.json"), "{}\n", "utf8");
      await writeFile(path.join(root, ".env"), "SECRET=hidden\n", "utf8");
      await mkdir(path.join(root, "node_modules"));
      const marker = path.join(root, "node_modules", "marker.txt");
      await writeFile(marker, "host dependency\n", "utf8");
      const shell = new DockerShellExecutor(
        new LocalCommandExecutor(),
        new Workspace(root),
        "integration",
        {
          ...parseSandboxConfig({}),
          image,
        },
      );

      const result = await shell.runScript({
        script: [
          "set -eu",
          "test -r node_modules/marker.txt",
          "! (printf changed >> node_modules/marker.txt 2>/dev/null)",
          "test ! -s .env",
          "printf workspace-write > output.txt",
          'printf "ready"',
        ].join("\n"),
        cwd: root,
        timeoutMs: 30_000,
        maxOutputChars: 10_000,
      });

      expect(result).toMatchObject({
        ok: true,
        stdout: "ready",
        timedOut: false,
        cancelled: false,
      });
      await expect(readFile(marker, "utf8")).resolves.toBe(
        "host dependency\n",
      );
      await expect(
        readFile(path.join(root, "output.txt"), "utf8"),
      ).resolves.toBe("workspace-write");
    },
    40_000,
  );
});
