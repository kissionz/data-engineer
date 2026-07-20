import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionStore } from "../agent/session.js";
import type { ToolOutcome } from "../protocol.js";
import type { Tool, ToolExecutionContext } from "../tools/base.js";
import type { Workspace } from "./workspace.js";
import {
  atomicReplaceTextFile,
  readTextFileSnapshot,
  type TextFileSnapshot,
} from "./textFile.js";
import { workspaceStateRoot } from "./productPaths.js";

interface CheckpointRecord {
  id: string;
  createdAt: string;
  turnId: string;
  toolCallId: string;
  operation: "create" | "edit";
  path: string;
  afterSha256: string;
  before?: {
    text: string;
    sha256: string;
  };
  restoredAt?: string;
}

export interface RewindResult {
  rewound: boolean;
  message: string;
  revertedPaths: string[];
}

export class CheckpointManager {
  private readonly filePath: string;

  constructor(
    private readonly workspace: Workspace,
    sessionDirectory: string,
  ) {
    const sessionsRoot = path.join(
      workspaceStateRoot(workspace.root),
      "sessions",
    );
    const resolvedDirectory = path.resolve(sessionDirectory);
    const relative = path.relative(sessionsRoot, resolvedDirectory);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.dirname(relative) !== "."
    ) {
      throw new Error(
        "Checkpoint storage must be one managed session directory.",
      );
    }
    this.filePath = path.join(resolvedDirectory, "checkpoints.json");
  }

  wrap(tool: Tool): Tool {
    if (!['Write', 'Edit'].includes(tool.name)) {
      return tool;
    }
    return new CheckpointingTool(tool, this);
  }

  async capture(
    tool: Tool,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolOutcome> {
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    const access = {
      allowOutside: context?.userApproved === true,
      outsideRoot: context?.approvedFolder,
      signal: context?.signal,
    };
    let before: TextFileSnapshot | undefined;

    if (tool.name === "Edit") {
      before = await readTextFileSnapshot(this.workspace, filePath, {
        ...access,
        forEdit: true,
      });
    }

    const result = await tool.execute(args, context);
    const afterSha256 = result.data?.sha256;
    if (!result.ok || typeof afterSha256 !== "string") {
      return result;
    }

    // External-folder approvals are intentionally not persisted into workspace
    // checkpoints: undo must never expand a previous permission grant.
    const absolutePath = this.workspace.resolve(filePath, access);
    if (!this.workspace.contains(absolutePath)) {
      return result;
    }

    const records = await this.load();
    records.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      turnId: context?.taskRunId ?? context?.toolCallId ?? "unknown",
      toolCallId: context?.toolCallId ?? "unknown",
      operation: before ? "edit" : "create",
      path: filePath,
      afterSha256,
      ...(before
        ? { before: { text: before.text, sha256: before.hash } }
        : {}),
    });
    await this.save(records.slice(-100));
    return result;
  }

  async rewindLatestTurn(session: SessionStore): Promise<RewindResult> {
    const events = await session.load();
    const turn = [...events].reverse().find(
      (event) => event.type === "user_message",
    );
    if (!turn || turn.type !== "user_message") {
      return {
        rewound: false,
        message: "No Montane conversation turn is available to rewind.",
        revertedPaths: [],
      };
    }

    const records = await this.load();
    const turnRecords = turn.turnId
      ? records.filter(
          (record) => !record.restoredAt && record.turnId === turn.turnId,
        )
      : [];
    const changes = collapseTurnChanges(turnRecords);

    const currentFiles = new Map<string, TextFileSnapshot>();
    for (const change of changes) {
      let current: TextFileSnapshot;
      try {
        current = await readTextFileSnapshot(this.workspace, change.path, {
          forEdit: true,
        });
      } catch {
        return {
          rewound: false,
          message: `Refusing to rewind: ${change.path} changed after the turn.`,
          revertedPaths: [],
        };
      }
      if (current.hash !== change.afterSha256) {
        return {
          rewound: false,
          message: `Refusing to rewind: ${change.path} changed after the turn.`,
          revertedPaths: [],
        };
      }
      currentFiles.set(change.path, current);
    }

    for (const change of changes) {
      const current = currentFiles.get(change.path);
      if (!current) {
        throw new Error(`Missing validated rewind snapshot: ${change.path}`);
      }
      if (change.operation === "create") {
        const info = await lstat(current.absolutePath);
        if (!info.isFile() || info.isSymbolicLink()) {
          return {
            rewound: false,
            message: "Refusing to remove an unsafe file path.",
            revertedPaths: [],
          };
        }
        await unlink(current.absolutePath);
      } else if (change.before) {
        await atomicReplaceTextFile(current, change.before.text);
      } else {
        throw new Error(`Checkpoint for ${change.path} has no prior contents.`);
      }
    }

    if (turnRecords.length > 0) {
      const restoredAt = new Date().toISOString();
      for (const record of turnRecords) {
        record.restoredAt = restoredAt;
      }
      await this.save(records);
    }
    await session.append({
      type: "session_rewind",
      targetSequence: Math.max(0, turn.sequence - 1),
      turnId: turn.turnId,
    });
    await session.append({
      type: "session_status_changed",
      status: "running",
    });
    const revertedPaths = changes.map((change) => change.path);
    return {
      rewound: true,
      message:
        revertedPaths.length > 0
          ? `Rewound the latest turn and restored ${revertedPaths.length} file(s).`
          : "Rewound the latest conversation turn.",
      revertedPaths,
    };
  }

  private async load(): Promise<CheckpointRecord[]> {
    try {
      const info = await lstat(this.filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("Checkpoint path is not a regular file.");
      }
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("Checkpoint file must contain an array.");
      }
      return parsed as CheckpointRecord[];
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  private async save(records: CheckpointRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(records)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

interface TurnChange {
  path: string;
  operation: CheckpointRecord["operation"];
  afterSha256: string;
  before?: CheckpointRecord["before"];
}

function collapseTurnChanges(records: CheckpointRecord[]): TurnChange[] {
  const changes = new Map<string, TurnChange>();
  for (const record of records) {
    const existing = changes.get(record.path);
    if (existing) {
      existing.afterSha256 = record.afterSha256;
    } else {
      changes.set(record.path, {
        path: record.path,
        operation: record.operation,
        afterSha256: record.afterSha256,
        before: record.before,
      });
    }
  }
  return [...changes.values()];
}

class CheckpointingTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly effect?: "readonly" | "side_effect";
  readonly timeoutMs?: number;
  readonly source?: Tool["source"];

  constructor(
    private readonly inner: Tool,
    private readonly checkpoints: CheckpointManager,
  ) {
    this.name = inner.name;
    this.description = inner.description;
    this.inputSchema = inner.inputSchema;
    this.effect = inner.effect;
    this.timeoutMs = inner.timeoutMs;
    this.source = inner.source;
  }

  execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolOutcome> {
    return this.checkpoints.capture(this.inner, args, context);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
