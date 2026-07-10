import { stat } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import type {
  CommandExecutor,
  CommandResult,
} from "../runtime/commandExecutor.js";
import { LocalCommandExecutor } from "../runtime/localExecutor.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  product: "Montane Code";
  ready: boolean;
  checks: DoctorCheck[];
}

interface DoctorOptions {
  cwd: string;
  json: boolean;
}

export async function runDoctorCommand(
  argv = process.argv.slice(2),
): Promise<boolean> {
  if (argv[0] !== "doctor") {
    return false;
  }

  const program = new Command();
  program
    .name("montane doctor")
    .description("Check whether this machine is ready to run Montane Code")
    .option("--cwd <path>", "Workspace directory", process.cwd())
    .option("--json", "Print a machine-readable report", false);
  program.parse(["node", "montane-doctor", ...argv.slice(1)]);

  const options = program.opts<DoctorOptions>();
  const report = await collectDoctorReport(
    path.resolve(options.cwd),
    new LocalCommandExecutor(),
  );
  printDoctorReport(report, options.json);
  if (!report.ready) {
    process.exitCode = 1;
  }
  return true;
}

export async function collectDoctorReport(
  workspaceRoot: string,
  executor: CommandExecutor,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [nodeCheck(process.versions.node)];
  checks.push(await workspaceCheck(workspaceRoot));

  if (checks.some((check) => check.status === "fail")) {
    return { product: "Montane Code", ready: false, checks };
  }

  const [git, repository, ripgrep, docker] = await Promise.all([
    probe(executor, workspaceRoot, "git", ["--version"]),
    probe(executor, workspaceRoot, "git", [
      "rev-parse",
      "--is-inside-work-tree",
    ]),
    probe(executor, workspaceRoot, "rg", ["--version"]),
    probe(executor, workspaceRoot, "docker", [
      "version",
      "--format",
      "{{.Server.Os}}",
    ]),
  ]);

  checks.push(
    capabilityCheck("Git", git, "Git tools will be unavailable."),
    repository.ok && repository.stdout.trim() === "true"
      ? pass("Git repository", "Workspace is inside a Git work tree.")
      : warn("Git repository", "Workspace is not inside a Git work tree."),
    capabilityCheck(
      "ripgrep",
      ripgrep,
      "Montane will use its bounded native search fallback.",
    ),
  );

  if (!docker.ok) {
    checks.push(
      warn(
        "Docker sandbox",
        "Docker daemon is unavailable; Bash stays disabled in auto mode. " +
          "Use --bash-sandbox host only for trusted workspaces.",
      ),
    );
  } else if (docker.stdout.trim().toLowerCase() !== "linux") {
    checks.push(
      warn(
        "Docker sandbox",
        "Docker is not using Linux containers; Bash stays disabled in auto mode.",
      ),
    );
  } else {
    const image = await probe(executor, workspaceRoot, "docker", [
      "image",
      "inspect",
      "node:22-bookworm",
    ]);
    checks.push(
      image.ok
        ? pass("Docker sandbox", "Docker and node:22-bookworm are ready.")
        : warn(
            "Docker sandbox",
            "Sandbox image node:22-bookworm is missing. Start with " +
              "--sandbox-pull missing once to download it.",
          ),
    );
  }

  checks.push(
    process.env.OPENAI_API_KEY
      ? pass("Model credentials", "OPENAI_API_KEY is configured.")
      : warn(
          "Model credentials",
          "OPENAI_API_KEY is not set; real model runs will not start.",
        ),
  );

  return {
    product: "Montane Code",
    ready: !checks.some((check) => check.status === "fail"),
    checks,
  };
}

function printDoctorReport(report: DoctorReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write("Montane Code doctor\n\n");
  for (const check of report.checks) {
    const marker =
      check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    process.stdout.write(`${marker} ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(
    `\n${report.ready ? "Ready" : "Not ready"} for Montane Code.\n`,
  );
}

function nodeCheck(version: string): DoctorCheck {
  const [major = 0, minor = 0] = version
    .split(".")
    .slice(0, 2)
    .map((value) => Number.parseInt(value, 10));
  return major > 22 || (major === 22 && minor >= 12)
    ? pass("Node.js", `v${version}`)
    : fail("Node.js", `v${version}; Montane requires Node.js 22.12 or newer.`);
}

async function workspaceCheck(workspaceRoot: string): Promise<DoctorCheck> {
  try {
    const info = await stat(workspaceRoot);
    return info.isDirectory()
      ? pass("Workspace", workspaceRoot)
      : fail("Workspace", `${workspaceRoot} is not a directory.`);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("Workspace", detail);
  }
}

async function probe(
  executor: CommandExecutor,
  cwd: string,
  command: string,
  args: string[],
): Promise<CommandResult> {
  return executor.run({
    command,
    args,
    cwd,
    timeoutMs: 5_000,
    maxOutputChars: 4_000,
  });
}

function capabilityCheck(
  name: string,
  result: CommandResult,
  unavailableDetail: string,
): DoctorCheck {
  return result.ok
    ? pass(name, result.stdout.trim().split("\n")[0] || "available")
    : warn(name, unavailableDetail);
}

function pass(name: string, detail: string): DoctorCheck {
  return { name, status: "pass", detail };
}

function warn(name: string, detail: string): DoctorCheck {
  return { name, status: "warn", detail };
}

function fail(name: string, detail: string): DoctorCheck {
  return { name, status: "fail", detail };
}
