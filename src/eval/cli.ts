import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { readSafeJson, writeSafeJson } from "./io.js";
import { evalSucceeded, runEvalSuite } from "./runner.js";
import {
  evalReportSchema,
  evalSuiteSchema,
  type EvalReport,
} from "./schema.js";

const execFileAsync = promisify(execFile);

interface CliOptions {
  suite: string;
  report: string;
  baseline?: string;
  includeGitSha: boolean;
}

export async function runEvalCli(
  argv: string[],
  workspaceRoot = process.cwd(),
): Promise<number> {
  const options = parseArgs(argv);
  const suite = await readSafeJson(
    workspaceRoot,
    options.suite,
    evalSuiteSchema,
  );
  const baseline: EvalReport | undefined = options.baseline
    ? await readSafeJson(
        workspaceRoot,
        options.baseline,
        evalReportSchema,
      )
    : undefined;
  const gitSha = options.includeGitSha
    ? await discoverGitSha(workspaceRoot)
    : undefined;
  const report = await runEvalSuite(suite, { baseline, gitSha });
  await writeSafeJson(workspaceRoot, options.report, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return evalSucceeded(report) ? 0 : 1;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    suite: "evals/deterministic.v1.json",
    report: ".harness/eval-report.json",
    includeGitSha: true,
  };
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-git-sha") {
      if (seen.has(argument)) {
        throw new Error(`Duplicate eval argument: ${argument}`);
      }
      seen.add(argument);
      options.includeGitSha = false;
      continue;
    }
    if (
      argument !== "--suite" &&
      argument !== "--report" &&
      argument !== "--baseline"
    ) {
      throw new Error(`Unknown eval argument: ${argument ?? ""}`);
    }
    if (seen.has(argument)) {
      throw new Error(`Duplicate eval argument: ${argument}`);
    }
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for eval argument: ${argument}`);
    }
    index += 1;
    if (argument === "--suite") {
      options.suite = value;
    } else if (argument === "--report") {
      options.report = value;
    } else {
      options.baseline = value;
    }
  }
  return options;
}

async function discoverGitSha(workspaceRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 4_096,
      },
    );
    const value = stdout.trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  runEvalCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Eval failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
    });
}
