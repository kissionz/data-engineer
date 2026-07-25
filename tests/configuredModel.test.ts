import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockModel } from "../src/model/mock.js";
import { resolveConfiguredModel } from "../src/model/configured.js";

const touchedKeys = [
  "MONTANE_PROVIDER",
  "MONTANE_MODEL",
  "OPENAI_PROVIDER",
  "OPENAI_MODEL",
];

afterEach(() => {
  for (const key of touchedKeys) delete process.env[key];
});

describe("resolveConfiguredModel", () => {
  it("reuses the CLI user config and env-file precedence for SDK consumers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-model-"));
    const configPath = path.join(root, "config.json");
    const envPath = path.join(root, "montane.env");
    await writeFile(envPath, "MONTANE_MODEL=env-selected-model\n", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        envFile: envPath,
        model: { provider: "mock", name: "config-model" },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(configPath, 0o600);

    const runtime = await resolveConfiguredModel({
      workspaceRoot: root,
      configPath,
    });

    expect(runtime.provider).toBe("mock");
    expect(runtime.model).toBe("env-selected-model");
    expect(runtime.client).toBeInstanceOf(MockModel);
    expect(runtime.envFilePath).toBe(envPath);
  });
});
