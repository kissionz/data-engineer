import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadEnvFile,
  loadStartupEnv,
  runtimeEnvFilePath,
  selectEnvFile,
} from "../src/runtime/env.js";

const touchedKeys = [
  "HARNESS_TEST_KEY",
  "HARNESS_EXISTING_KEY",
  "HARNESS_WORKSPACE_KEY",
];

describe("loadEnvFile", () => {
  afterEach(() => {
    for (const key of touchedKeys) {
      delete process.env[key];
    }
  });

  it("loads simple dotenv values without overwriting existing env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-env-"));
    const envPath = path.join(root, ".env");
    process.env.HARNESS_EXISTING_KEY = "from-shell";

    await writeFile(
      envPath,
      [
        "# comment",
        "HARNESS_TEST_KEY=\"from file\"",
        "HARNESS_EXISTING_KEY=from-file",
      ].join("\n"),
      "utf8",
    );

    await loadEnvFile(envPath);

    expect(process.env.HARNESS_TEST_KEY).toBe("from file");
    expect(process.env.HARNESS_EXISTING_KEY).toBe("from-shell");
  });

  it("fails when an explicitly selected env file does not exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-env-"));

    await expect(
      loadEnvFile(path.join(root, "missing.env")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows the default workspace env file to be absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-env-"));

    await expect(
      loadEnvFile(path.join(root, ".env"), { allowMissing: true }),
    ).resolves.toBeUndefined();
  });

  it("selects CLI, user-config, and workspace env files in precedence order", () => {
    const workspaceRoot = path.join(os.tmpdir(), "workspace");
    const configPath = path.join(os.tmpdir(), "home", ".harness", "config.json");

    expect(
      selectEnvFile({
        workspaceRoot,
        userConfigPath: configPath,
        cliEnvFile: "task.env",
        userEnvFile: "global.env",
      }),
    ).toEqual({
      filePath: path.join(workspaceRoot, "task.env"),
      allowMissing: false,
      source: "cli",
    });

    expect(
      selectEnvFile({
        workspaceRoot,
        userConfigPath: configPath,
        userEnvFile: "global.env",
      }),
    ).toEqual({
      filePath: path.join(os.tmpdir(), "home", ".harness", "global.env"),
      allowMissing: false,
      source: "user_config",
    });

    expect(
      selectEnvFile({
        workspaceRoot,
        userConfigPath: configPath,
      }),
    ).toEqual({
      filePath: path.join(workspaceRoot, ".env"),
      allowMissing: true,
      source: "workspace",
    });
  });

  it("keeps an absolute user-config env file path unchanged", () => {
    const envPath = path.resolve(os.tmpdir(), "shared", ".env");

    expect(
      selectEnvFile({
        workspaceRoot: path.join(os.tmpdir(), "workspace"),
        userConfigPath: path.join(os.tmpdir(), "home", ".harness", "config.json"),
        userEnvFile: envPath,
      }).filePath,
    ).toBe(envPath);
  });

  it("finds the env file beside the runtime source or dist directory", () => {
    const projectRoot = path.join(os.tmpdir(), "harness-install");
    const moduleUrl = pathToFileURL(
      path.join(projectRoot, "dist", "index.js"),
    ).href;

    expect(runtimeEnvFilePath(moduleUrl)).toBe(
      path.join(projectRoot, ".env"),
    );
  });

  it("automatically loads runtime env and supplements it from workspace env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-env-startup-"));
    const runtimeRoot = path.join(root, "runtime");
    const workspaceRoot = path.join(root, "workspace");
    const moduleUrl = pathToFileURL(
      path.join(runtimeRoot, "dist", "index.js"),
    ).href;
    await Promise.all([
      mkdir(runtimeRoot, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(runtimeRoot, ".env"),
        "HARNESS_TEST_KEY=runtime\n",
        "utf8",
      ),
      writeFile(
        path.join(workspaceRoot, ".env"),
        [
          "HARNESS_TEST_KEY=workspace",
          "HARNESS_WORKSPACE_KEY=workspace",
        ].join("\n"),
        "utf8",
      ),
    ]);

    await loadStartupEnv(
      selectEnvFile({
        workspaceRoot,
        userConfigPath: path.join(root, "home", ".harness", "config.json"),
      }),
      moduleUrl,
    );

    expect(process.env.HARNESS_TEST_KEY).toBe("runtime");
    expect(process.env.HARNESS_WORKSPACE_KEY).toBe("workspace");
  });
});
