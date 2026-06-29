import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runEvalCli } from "../src/eval/cli.js";
import { readSafeJson, writeSafeJson } from "../src/eval/io.js";
import { evalSucceeded, runEvalSuite } from "../src/eval/runner.js";
import {
  evalReportSchema,
  evalSuiteSchema,
  type EvalReport,
  type EvalSuite,
} from "../src/eval/schema.js";

const oneCaseSuite: EvalSuite = {
  schemaVersion: 1,
  suiteId: "offline-test",
  suiteVersion: "1.0.0",
  cases: [
    {
      id: "exact-edit",
      scenario: "exact_edit",
      scenarioVersion: 1,
    },
  ],
};

describe("offline eval", () => {
  it("runs a deterministic mock scenario and emits privacy-safe metadata", async () => {
    const report = await runEvalSuite(oneCaseSuite, {
      gitSha: "A".repeat(40),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      suite: { id: "offline-test", version: "1.0.0" },
      runtime: {
        provider: "mock",
        model: "scripted-acceptance-v1",
        config: "offline-deterministic-v1",
        gitSha: "a".repeat(40),
      },
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        baselineRegressions: 0,
      },
      cases: [
        {
          id: "exact-edit",
          scenario: "exact_edit",
          status: "pass",
        },
      ],
    });
    expect(evalSucceeded(report)).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("edit fixture");
    expect(serialized).not.toContain("pnpm install");
    expect(serialized).not.toContain("tool_result");
  });

  it("marks a formerly passing baseline case missing from the suite as a regression", async () => {
    const baseline = baselineReport({
      id: "removed-case",
      scenario: "project_analysis",
      status: "pass",
      durationMs: 1,
    });

    const report = await runEvalSuite(oneCaseSuite, { baseline });

    expect(report.baseline?.regressions).toEqual(["removed-case"]);
    expect(report.summary.baselineRegressions).toBe(1);
    expect(evalSucceeded(report)).toBe(false);
  });

  it("rejects baselines for a different suite", async () => {
    const baseline = {
      ...baselineReport({
        id: "exact-edit",
        scenario: "exact_edit",
        status: "pass",
        durationMs: 1,
      }),
      suite: { id: "different-suite", version: "1.0.0" },
    };

    await expect(
      runEvalSuite(oneCaseSuite, { baseline }),
    ).rejects.toThrow("does not match");
  });

  it("runs through the CLI and writes a schema-valid JSON report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-eval-test-"));
    await writeFile(
      path.join(root, "suite.json"),
      JSON.stringify(oneCaseSuite),
      "utf8",
    );
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await expect(
        runEvalCli(
          [
            "--suite",
            "suite.json",
            "--report",
            "reports/current.json",
            "--no-git-sha",
          ],
          root,
        ),
      ).resolves.toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const report = JSON.parse(
      await readFile(path.join(root, "reports", "current.json"), "utf8"),
    ) as unknown;
    expect(() => evalReportSchema.parse(report)).not.toThrow();
  });

  it("returns a failing CLI status when baseline comparison regresses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-eval-test-"));
    await writeFile(
      path.join(root, "suite.json"),
      JSON.stringify(oneCaseSuite),
      "utf8",
    );
    await writeFile(
      path.join(root, "baseline.json"),
      JSON.stringify(
        baselineReport({
          id: "removed-case",
          scenario: "project_analysis",
          status: "pass",
          durationMs: 1,
        }),
      ),
      "utf8",
    );
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await expect(
        runEvalCli(
          [
            "--suite",
            "suite.json",
            "--report",
            "report.json",
            "--baseline",
            "baseline.json",
            "--no-git-sha",
          ],
          root,
        ),
      ).resolves.toBe(1);
    } finally {
      stdout.mockRestore();
    }
  });

  it("strictly rejects unknown suite fields and duplicate case ids", () => {
    expect(() =>
      evalSuiteSchema.parse({ ...oneCaseSuite, prompt: "do something" }),
    ).toThrow("Unrecognized key");
    expect(() =>
      evalSuiteSchema.parse({
        ...oneCaseSuite,
        cases: [oneCaseSuite.cases[0], oneCaseSuite.cases[0]],
      }),
    ).toThrow("Duplicate eval case id");
  });

  it("rejects path traversal, symlink input, non-files, and oversized input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-eval-test-"));
    await expect(
      readSafeJson(root, "../suite.json", evalSuiteSchema),
    ).rejects.toThrow("escapes");

    await mkdir(path.join(root, "directory.json"));
    await expect(
      readSafeJson(root, "directory.json", evalSuiteSchema),
    ).rejects.toThrow("non-file");

    await writeFile(
      path.join(root, "large.json"),
      " ".repeat(1024 * 1024 + 1),
      "utf8",
    );
    await expect(
      readSafeJson(root, "large.json", evalSuiteSchema),
    ).rejects.toThrow("1 MiB");

    if (process.platform !== "win32") {
      await writeFile(path.join(root, "real.json"), "{}", "utf8");
      await symlink(
        path.join(root, "real.json"),
        path.join(root, "linked.json"),
      );
      await expect(
        readSafeJson(root, "linked.json", evalSuiteSchema),
      ).rejects.toThrow("symbolic link");
    }
  });

  it.runIf(process.platform !== "win32")(
    "refuses symlinks in eval report paths",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "harness-eval-test-"),
      );
      const outside = await mkdtemp(
        path.join(os.tmpdir(), "harness-eval-outside-"),
      );
      await symlink(outside, path.join(root, "linked-directory"));
      await expect(
        writeSafeJson(root, "linked-directory/report.json", {}),
      ).rejects.toThrow("unsafe eval report directory");

      await writeFile(path.join(root, "target.json"), "{}", "utf8");
      await symlink(
        path.join(root, "target.json"),
        path.join(root, "report.json"),
      );
      await expect(
        writeSafeJson(root, "report.json", {}),
      ).rejects.toThrow("symbolic link");
    },
  );
});

function baselineReport(
  result: EvalReport["cases"][number],
): EvalReport {
  return {
    schemaVersion: 1,
    suite: { id: "offline-test", version: "0.9.0" },
    runtime: {
      provider: "mock",
      model: "scripted-acceptance-v1",
      config: "offline-deterministic-v1",
    },
    summary: {
      total: 1,
      passed: result.status === "pass" ? 1 : 0,
      failed: result.status === "fail" ? 1 : 0,
      durationMs: result.durationMs,
      baselineRegressions: 0,
    },
    cases: [result],
  };
}
