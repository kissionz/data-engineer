import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/runtime/env.js";

const touchedKeys = ["HARNESS_TEST_KEY", "HARNESS_EXISTING_KEY"];

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
});
