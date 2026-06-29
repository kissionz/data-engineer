import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const version = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);

export const evalScenarioSchema = z.enum([
  "project_analysis",
  "failure_diagnosis",
  "exact_edit",
  "fix_and_verify",
  "destructive_command_denied",
]);

export const evalSuiteSchema = z
  .object({
    $schema: z.literal("./suite.schema.v1.json").optional(),
    schemaVersion: z.literal(1),
    suiteId: identifier,
    suiteVersion: version,
    cases: z
      .array(
        z
          .object({
            id: identifier,
            scenario: evalScenarioSchema,
            scenarioVersion: z.literal(1),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((suite, context) => {
    const ids = new Set<string>();
    suite.cases.forEach((testCase, index) => {
      if (ids.has(testCase.id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: `Duplicate eval case id: ${testCase.id}`,
        });
      }
      ids.add(testCase.id);
    });
  });

const evalCaseResultSchema = z
  .object({
    id: identifier,
    scenario: evalScenarioSchema,
    status: z.enum(["pass", "fail"]),
    durationMs: z.number().int().nonnegative(),
    failureCode: identifier.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "pass" && result.failureCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Passing eval cases cannot contain a failureCode.",
      });
    }
    if (result.status === "fail" && result.failureCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Failing eval cases require a failureCode.",
      });
    }
  });

export const evalReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    suite: z
      .object({
        id: identifier,
        version,
      })
      .strict(),
    runtime: z
      .object({
        provider: z.literal("mock"),
        model: z.literal("scripted-acceptance-v1"),
        config: z.literal("offline-deterministic-v1"),
        gitSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
      })
      .strict(),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
        baselineRegressions: z.number().int().nonnegative(),
      })
      .strict(),
    cases: z.array(evalCaseResultSchema).max(100),
    baseline: z
      .object({
        compared: z.literal(true),
        suiteVersion: version,
        regressions: z.array(identifier).max(100),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((report, context) => {
    const ids = new Set<string>();
    report.cases.forEach((result, index) => {
      if (ids.has(result.id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: `Duplicate eval report case id: ${result.id}`,
        });
      }
      ids.add(result.id);
    });
    const passed = report.cases.filter(
      (result) => result.status === "pass",
    ).length;
    const failed = report.cases.length - passed;
    if (
      report.summary.total !== report.cases.length ||
      report.summary.passed !== passed ||
      report.summary.failed !== failed
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "Eval report summary does not match its case results.",
      });
    }
    if (
      report.summary.baselineRegressions !==
      (report.baseline?.regressions.length ?? 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary", "baselineRegressions"],
        message: "Eval baseline regression count is inconsistent.",
      });
    }
  });

export type EvalScenario = z.infer<typeof evalScenarioSchema>;
export type EvalSuite = z.infer<typeof evalSuiteSchema>;
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;
export type EvalReport = z.infer<typeof evalReportSchema>;
