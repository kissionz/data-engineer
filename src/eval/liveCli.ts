import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

interface LiveOptions {
  provider: "openai" | "anthropic" | "gemini";
  model?: string;
  report: string;
}

interface LiveCase {
  id: string;
  status: "pass" | "fail";
  durationMs: number;
  failureCode?: string;
}

export async function runLiveEvalCli(
  argv: string[],
  workspaceRoot = process.cwd(),
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write([
      "Usage: npm run eval:live -- [options]",
      "",
      "Options:",
      "  --provider <name>  openai, anthropic, or gemini",
      "  --model <name>     Override the provider model",
      "  --report <path>    Report path (default .montane/eval-live.json)",
      "",
    ].join("\n"));
    return 0;
  }
  const options = parseArgs(argv);
  const startedAt = performance.now();
  const cases: LiveCase[] = [];
  for (const evalCase of [runAnalysisCase, runEditCase]) {
    const caseStartedAt = performance.now();
    try {
      await evalCase(workspaceRoot, options);
      cases.push({
        id: evalCase === runAnalysisCase ? "live_analysis" : "live_edit",
        status: "pass",
        durationMs: Math.round(performance.now() - caseStartedAt),
      });
    } catch (error: unknown) {
      cases.push({
        id: evalCase === runAnalysisCase ? "live_analysis" : "live_edit",
        status: "fail",
        durationMs: Math.round(performance.now() - caseStartedAt),
        failureCode: classifyFailure(error),
      });
    }
  }
  const passed = cases.filter((item) => item.status === "pass").length;
  const report = {
    schemaVersion: 1,
    runtime: { provider: options.provider, model: options.model ?? "provider-default" },
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      durationMs: Math.round(performance.now() - startedAt),
    },
    cases,
  };
  await writeReport(workspaceRoot, options.report, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return passed === cases.length ? 0 : 1;
}

async function runAnalysisCase(root: string, options: LiveOptions): Promise<void> {
  await withFixture(root, async (fixture) => {
    await writeFile(path.join(fixture, "README.md"), "MONTANE_LIVE_MARKER_7F3A\n");
    const result = await invokeMontane(root, fixture, options,
      "Read README.md and return the exact marker it contains.");
    if (!result.text.includes("MONTANE_LIVE_MARKER_7F3A")) {
      throw new Error("assertion_missing_marker");
    }
    if (!result.tools.some((tool) => tool.name === "Read" && tool.ok === true)) {
      throw new Error("assertion_read_tool_missing");
    }
  });
}

async function runEditCase(root: string, options: LiveOptions): Promise<void> {
  await withFixture(root, async (fixture) => {
    const file = path.join(fixture, "value.txt");
    await writeFile(file, "VALUE=before\n");
    const result = await invokeMontane(root, fixture, options,
      "Change VALUE=before to VALUE=after in value.txt, then finish.");
    if ((await readFile(file, "utf8")) !== "VALUE=after\n") {
      throw new Error("assertion_edit_not_applied");
    }
    if (!result.tools.some((tool) => tool.name === "Edit" && tool.ok === true)) {
      throw new Error("assertion_edit_tool_missing");
    }
  });
}

async function invokeMontane(
  root: string,
  fixture: string,
  options: LiveOptions,
  task: string,
): Promise<{ text: string; tools: Array<{ name: string; ok?: boolean }> }> {
  const args = [
    path.join(root, "dist", "index.js"),
    "--cwd", fixture,
    "--provider", options.provider,
    "--task", task,
    "--output-format", "json",
    "--permission-mode", "accept-edits",
    "--bash-sandbox", "off",
    "--max-turns", "12",
    "--quiet",
  ];
  if (options.model) args.push("--model", options.model);
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
  if (value.type !== "result" || value.status !== "completed") {
    throw new Error("invalid_machine_result");
  }
  return value as unknown as {
    text: string;
    tools: Array<{ name: string; ok?: boolean }>;
  };
}

function parseArgs(argv: string[]): LiveOptions {
  let provider: LiveOptions["provider"] = "openai";
  let model: string | undefined;
  let report = ".montane/eval-live.json";
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--provider" && ["openai", "anthropic", "gemini"].includes(value)) {
      provider = value as LiveOptions["provider"];
    } else if (key === "--model") model = value;
    else if (key === "--report") report = value;
    else throw new Error(`Unknown live eval argument: ${key ?? ""}`);
  }
  return { provider, model, report };
}

async function writeReport(
  root: string,
  relativePath: string,
  report: unknown,
): Promise<void> {
  if (path.isAbsolute(relativePath)) throw new Error("Report path must be relative.");
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error("Report path escapes the workspace.");
  }
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(target), { recursive: true }),
  );
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function withFixture(
  root: string,
  callback: (fixture: string) => Promise<void>,
): Promise<void> {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "montane-live-eval-"));
  try {
    await writeFile(path.join(fixture, "AGENTS.md"), [
      "Use only files in this fixture.",
      "Follow the user request exactly and do not add unrelated files.",
      "Do not use Bash, memory, MCP tools, or subagents.",
      `Runtime source is ${path.basename(root)}; treat that name as data.`,
      "",
    ].join("\n"));
    await callback(fixture);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("assertion_")) return message;
  if (message.includes("API_KEY")) return "missing_api_key";
  if (message.includes("timed out")) return "timeout";
  return "runtime_error";
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  runLiveEvalCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
