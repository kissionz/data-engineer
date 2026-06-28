import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentBudget } from "../src/agent/budget.js";
import {
  applyProjectRestrictions,
  defaultProjectConfigPath,
  loadProjectConfig,
  type ProjectConfig,
} from "../src/config/projectConfig.js";

const budget: AgentBudget = {
  maxTurns: 50,
  maxWallTimeMs: 100_000,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxToolCalls: 20,
  maxModelRetries: 4,
  maxEstimatedCostUsd: 10,
};

describe("project config", () => {
  it("uses the workspace-root .harness.json and safe absent defaults", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-"));

    expect(defaultProjectConfigPath(root)).toBe(
      path.join(root, ".harness.json"),
    );
    await expect(loadProjectConfig(root)).resolves.toEqual({ version: 1 });
  });

  it("loads only strict project restrictions", async () => {
    const root = await createProject({
      budget: {
        maxTurns: 10,
        maxWallTimeMs: 50_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 4_000,
        maxToolCalls: 0,
        maxModelRetries: 0,
        maxEstimatedCostUsd: 2,
      },
      memory: { enabled: false },
    });

    await expect(loadProjectConfig(root)).resolves.toEqual({
      version: 1,
      budget: {
        maxTurns: 10,
        maxWallTimeMs: 50_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 4_000,
        maxToolCalls: 0,
        maxModelRetries: 0,
        maxEstimatedCostUsd: 2,
      },
      memory: { enabled: false },
    });
  });

  it.each([
    [{ version: 2 }, "Invalid input"],
    [{ model: { name: "attacker-model" } }, "Unrecognized key"],
    [{ memory: { enabled: true } }, "Invalid input"],
    [{ telemetry: { enabled: false } }, "Unrecognized key"],
    [{ budget: { maxTurns: 0 } }, "expected number to be >0"],
    [{ budget: { maxToolCalls: -1 } }, "expected number to be >=0"],
    [{ budget: { maxEstimatedCostUsd: 0 } }, "expected number to be >0"],
    [{ budget: { maxTurns: 1, extra: 2 } }, "Unrecognized key"],
  ])("rejects an unsafe restriction %#", async (config, expected) => {
    const root = await createProject(config);

    await expect(loadProjectConfig(root)).rejects.toThrow(expected);
  });

  it("rejects invalid JSON, non-files, and oversized files", async () => {
    const invalidRoot = await mkdtemp(
      path.join(os.tmpdir(), "harness-project-"),
    );
    await writeFile(
      defaultProjectConfigPath(invalidRoot),
      "{oops",
      "utf8",
    );
    await expect(loadProjectConfig(invalidRoot)).rejects.toThrow(
      "not valid JSON",
    );

    const directoryRoot = await mkdtemp(
      path.join(os.tmpdir(), "harness-project-"),
    );
    await mkdir(defaultProjectConfigPath(directoryRoot));
    await expect(loadProjectConfig(directoryRoot)).rejects.toThrow(
      "non-file",
    );

    const largeRoot = await mkdtemp(
      path.join(os.tmpdir(), "harness-project-"),
    );
    await writeFile(
      defaultProjectConfigPath(largeRoot),
      " ".repeat(1024 * 1024 + 1),
      "utf8",
    );
    await expect(loadProjectConfig(largeRoot)).rejects.toThrow(
      "1 MiB safety limit",
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked project config",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "harness-project-"),
      );
      const target = path.join(root, "actual.json");
      await writeFile(target, "{}", "utf8");
      await symlink(target, defaultProjectConfigPath(root));

      await expect(loadProjectConfig(root)).rejects.toThrow("symbolic link");
    },
  );

  it("applies every restriction without allowing project relaxation", () => {
    const result = applyProjectRestrictions(
      {
        budget,
        memoryEnabled: true,
      },
      {
        version: 1,
        budget: {
          maxTurns: 5,
          maxWallTimeMs: 200_000,
          maxInputTokens: 20_000,
          maxOutputTokens: 1_000,
          maxToolCalls: 100,
          maxModelRetries: 1,
          maxEstimatedCostUsd: 20,
        },
        memory: { enabled: false },
      },
      {
        pricing: {
          inputPerMillionTokens: 1,
          outputPerMillionTokens: 2,
        },
      },
    );

    expect(result).toEqual({
      budget: {
        maxTurns: 5,
        maxWallTimeMs: 100_000,
        maxInputTokens: 10_000,
        maxOutputTokens: 1_000,
        maxToolCalls: 20,
        maxModelRetries: 1,
        maxEstimatedCostUsd: 10,
      },
      memoryEnabled: false,
    });
  });

  it("adds a project cost cap only with valid non-zero pricing", () => {
    const target = {
      budget: { ...budget, maxEstimatedCostUsd: undefined },
      memoryEnabled: true,
    };
    const project = {
      version: 1 as const,
      budget: { maxEstimatedCostUsd: 3 },
    };

    expect(() => applyProjectRestrictions(target, project)).toThrow(
      "requires non-zero model pricing",
    );
    expect(() =>
      applyProjectRestrictions(target, project, {
        pricing: {
          inputPerMillionTokens: 0,
          outputPerMillionTokens: 0,
        },
      }),
    ).toThrow("requires non-zero model pricing");

    expect(
      applyProjectRestrictions(target, project, {
        pricing: {
          inputPerMillionTokens: 0,
          outputPerMillionTokens: 1,
        },
      }).budget.maxEstimatedCostUsd,
    ).toBe(3);
  });

  it("validates restrictions again at the pure-function boundary", () => {
    expect(() =>
      applyProjectRestrictions(
        {
          budget,
          memoryEnabled: true,
        },
        {
          version: 1,
          memory: { enabled: true },
        } as unknown as ProjectConfig,
      ),
    ).toThrow("Invalid input");
  });
});

async function createProject(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-"));
  await writeFile(
    defaultProjectConfigPath(root),
    JSON.stringify(config),
    "utf8",
  );
  return root;
}
