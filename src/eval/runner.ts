import { performance } from "node:perf_hooks";
import { evalFailureCode, runScenario } from "./scenarios.js";
import {
  evalReportSchema,
  evalSuiteSchema,
  type EvalCaseResult,
  type EvalReport,
  type EvalSuite,
} from "./schema.js";

export interface EvalRunOptions {
  gitSha?: string;
  baseline?: EvalReport;
  now?: () => number;
}

export async function runEvalSuite(
  input: EvalSuite,
  options: EvalRunOptions = {},
): Promise<EvalReport> {
  const suite = evalSuiteSchema.parse(input);
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const cases: EvalCaseResult[] = [];

  for (const testCase of suite.cases) {
    const caseStartedAt = now();
    try {
      await runScenario(testCase.scenario);
      cases.push({
        id: testCase.id,
        scenario: testCase.scenario,
        status: "pass",
        durationMs: elapsed(caseStartedAt, now()),
      });
    } catch (error: unknown) {
      cases.push({
        id: testCase.id,
        scenario: testCase.scenario,
        status: "fail",
        durationMs: elapsed(caseStartedAt, now()),
        failureCode: evalFailureCode(error),
      });
    }
  }

  const regressions = options.baseline
    ? compareBaseline(suite, cases, options.baseline)
    : [];
  const passed = cases.filter((result) => result.status === "pass").length;
  const report: EvalReport = {
    schemaVersion: 1,
    suite: {
      id: suite.suiteId,
      version: suite.suiteVersion,
    },
    runtime: {
      provider: "mock",
      model: "scripted-acceptance-v1",
      config: "offline-deterministic-v1",
      ...(options.gitSha ? { gitSha: normalizeGitSha(options.gitSha) } : {}),
    },
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      durationMs: elapsed(startedAt, now()),
      baselineRegressions: regressions.length,
    },
    cases,
    ...(options.baseline
      ? {
          baseline: {
            compared: true as const,
            suiteVersion: options.baseline.suite.version,
            regressions,
          },
        }
      : {}),
  };
  return evalReportSchema.parse(report);
}

export function evalSucceeded(report: EvalReport): boolean {
  return (
    report.summary.failed === 0 &&
    report.summary.baselineRegressions === 0
  );
}

function compareBaseline(
  suite: EvalSuite,
  current: EvalCaseResult[],
  baselineInput: EvalReport,
): string[] {
  const baseline = evalReportSchema.parse(baselineInput);
  if (baseline.suite.id !== suite.suiteId) {
    throw new Error("Eval baseline suite id does not match the current suite.");
  }
  const currentById = new Map(current.map((result) => [result.id, result]));
  return baseline.cases
    .filter((result) => result.status === "pass")
    .filter((result) => currentById.get(result.id)?.status !== "pass")
    .map((result) => result.id)
    .sort();
}

function normalizeGitSha(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("Eval git SHA must contain exactly 40 hexadecimal characters.");
  }
  return normalized;
}

function elapsed(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("Eval clock must be finite and monotonic.");
  }
  return Math.round(end - start);
}
