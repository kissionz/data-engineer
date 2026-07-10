import { lstat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import {
  LEGACY_STATE_DIRECTORY_NAME,
  STATE_DIRECTORY_NAME,
} from "../runtime/productPaths.js";

type MigrationStatus = "migrated" | "planned" | "absent" | "conflict";

export interface MigrationResult {
  scope: "workspace" | "user" | "project_config";
  source: string;
  target: string;
  status: MigrationStatus;
  detail: string;
}

interface MigrationOptions {
  cwd: string;
  workspace: boolean;
  user: boolean;
  all: boolean;
  dryRun: boolean;
  json: boolean;
}

export async function runMigrationCommand(
  argv = process.argv.slice(2),
): Promise<boolean> {
  if (argv[0] !== "migrate") {
    return false;
  }

  const program = new Command();
  program
    .name("montane migrate")
    .description("Migrate legacy .harness state to Montane paths")
    .option("--cwd <path>", "Workspace directory", process.cwd())
    .option("--workspace", "Migrate workspace state and project config", false)
    .option("--user", "Migrate user-level state", false)
    .option("--all", "Migrate workspace and user-level state", false)
    .option("--dry-run", "Show changes without renaming anything", false)
    .option("--json", "Print machine-readable results", false);
  program.parse(["node", "montane-migrate", ...argv.slice(1)]);
  const options = program.opts<MigrationOptions>();

  if (!options.workspace && !options.user && !options.all) {
    throw new Error("Select --workspace, --user, or --all.");
  }

  const results = await migrateLegacyState({
    workspaceRoot: path.resolve(options.cwd),
    userHome: homedir(),
    workspace: options.workspace || options.all,
    user: options.user || options.all,
    dryRun: options.dryRun,
  });
  printMigrationResults(results, options.json);
  if (results.some((result) => result.status === "conflict")) {
    process.exitCode = 1;
  }
  return true;
}

export async function migrateLegacyState(options: {
  workspaceRoot: string;
  userHome: string;
  workspace: boolean;
  user: boolean;
  dryRun?: boolean;
}): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  if (options.workspace) {
    results.push(
      await migratePath(
        "workspace",
        path.join(options.workspaceRoot, LEGACY_STATE_DIRECTORY_NAME),
        path.join(options.workspaceRoot, STATE_DIRECTORY_NAME),
        options.dryRun === true,
      ),
      await migratePath(
        "project_config",
        path.join(options.workspaceRoot, ".harness.json"),
        path.join(options.workspaceRoot, ".montane.json"),
        options.dryRun === true,
      ),
    );
  }
  if (options.user) {
    results.push(
      await migratePath(
        "user",
        path.join(options.userHome, LEGACY_STATE_DIRECTORY_NAME),
        path.join(options.userHome, STATE_DIRECTORY_NAME),
        options.dryRun === true,
      ),
    );
  }
  return results;
}

async function migratePath(
  scope: MigrationResult["scope"],
  source: string,
  target: string,
  dryRun: boolean,
): Promise<MigrationResult> {
  const sourceInfo = await lstat(source).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (!sourceInfo) {
    return { scope, source, target, status: "absent", detail: "Nothing to migrate." };
  }
  if (sourceInfo.isSymbolicLink()) {
    return {
      scope,
      source,
      target,
      status: "conflict",
      detail: "Legacy path is a symbolic link and will not be migrated.",
    };
  }
  const targetInfo = await lstat(target).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (targetInfo) {
    return {
      scope,
      source,
      target,
      status: "conflict",
      detail: "Both legacy and Montane paths exist; merge them manually.",
    };
  }
  if (dryRun) {
    return { scope, source, target, status: "planned", detail: "Ready to migrate." };
  }
  await rename(source, target);
  return { scope, source, target, status: "migrated", detail: "Migration complete." };
}

function printMigrationResults(results: MigrationResult[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  process.stdout.write("Montane state migration\n\n");
  for (const result of results) {
    process.stdout.write(
      `${result.status.padEnd(8)} ${result.scope}: ${result.source} -> ${result.target}\n`,
    );
    process.stdout.write(`         ${result.detail}\n`);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
