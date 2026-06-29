import type { CommandExecutor } from "./commandExecutor.js";

const MAX_GIT_OUTPUT_CHARS = 2 * 1024 * 1024;

export interface WorktreeStatus {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
  clean?: boolean;
  changeCount?: number;
  statusError?: string;
}

interface WorktreeRecord {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
}

export async function inspectWorktrees(
  executor: CommandExecutor,
  cwd: string,
): Promise<WorktreeStatus[]> {
  const listed = await executor.run({
    command: "git",
    args: ["--no-optional-locks", "worktree", "list", "--porcelain", "-z"],
    cwd,
    timeoutMs: 20_000,
    maxOutputChars: MAX_GIT_OUTPUT_CHARS,
  });
  if (!listed.ok || listed.outputTruncated) {
    throw new Error(
      `Unable to list worktrees: ${boundedError(listed.stderr || listed.stdout)}`,
    );
  }

  const records = parseWorktreePorcelain(listed.stdout);
  const statuses: WorktreeStatus[] = [];
  // Keep this sequential: porcelain output is bounded by bytes, not record
  // count, and spawning one status process per record at once can exhaust FDs.
  for (const record of records) {
    if (record.bare || record.prunable) {
      statuses.push(record);
      continue;
    }
    const status = await executor.run({
      command: "git",
      args: [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ],
      cwd: record.path,
      timeoutMs: 20_000,
      maxOutputChars: MAX_GIT_OUTPUT_CHARS,
    });
    if (!status.ok || status.outputTruncated) {
      statuses.push({
        ...record,
        statusError: boundedError(status.stderr || status.stdout),
      });
      continue;
    }
    const changeCount = status.stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0).length;
    statuses.push({
      ...record,
      clean: changeCount === 0,
      changeCount,
    });
  }
  return statuses;
}

export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  for (const rawRecord of output.split("\0\0")) {
    if (!rawRecord) {
      continue;
    }
    const fields = rawRecord.split("\0").filter(Boolean);
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (const field of fields) {
      const separator = field.indexOf(" ");
      if (separator === -1) {
        flags.add(field);
      } else {
        values.set(field.slice(0, separator), field.slice(separator + 1));
      }
    }
    const worktreePath = values.get("worktree");
    const head = values.get("HEAD");
    if (!worktreePath || !head || !/^[0-9a-f]{40,64}$/i.test(head)) {
      throw new Error("Git returned an invalid worktree record.");
    }
    records.push({
      path: worktreePath,
      head,
      ...(values.has("branch")
        ? { branch: values.get("branch")!.replace(/^refs\/heads\//, "") }
        : {}),
      detached: flags.has("detached"),
      bare: flags.has("bare"),
      ...(values.has("locked") || flags.has("locked")
        ? { locked: values.get("locked") ?? "" }
        : {}),
      ...(values.has("prunable") || flags.has("prunable")
        ? { prunable: values.get("prunable") ?? "" }
        : {}),
    });
  }
  return records;
}

function boundedError(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.slice(0, 500) || "unknown git error";
}
