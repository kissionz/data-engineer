import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "../tools/base.js";
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

export interface UndoResult {
  restored: boolean;
  message: string;
}

export class CheckpointManager {
  private readonly filePath: string;

  constructor(
    private readonly workspace: Workspace,
    sessionId: string,
  ) {
    this.filePath = path.join(
      workspaceStateRoot(workspace.root),
      "checkpoints",
      `${sessionId}.json`,
    );
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
  ): Promise<ToolExecutionResult> {
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

  async undoLatest(): Promise<UndoResult> {
    const records = await this.load();
    const record = [...records].reverse().find((item) => !item.restoredAt);
    if (!record) {
      return { restored: false, message: "No Montane edit checkpoint is available." };
    }

    const current = await readTextFileSnapshot(this.workspace, record.path, {
      forEdit: true,
    });
    if (current.hash !== record.afterSha256) {
      return {
        restored: false,
        message: `Refusing to undo ${record.path}: the file changed after the checkpoint.`,
      };
    }

    if (record.operation === "create") {
      const info = await lstat(current.absolutePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        return { restored: false, message: "Refusing to remove an unsafe file path." };
      }
      await unlink(current.absolutePath);
    } else if (record.before) {
      await atomicReplaceTextFile(current, record.before.text);
    }

    record.restoredAt = new Date().toISOString();
    await this.save(records);
    return { restored: true, message: `Restored ${record.path} from checkpoint.` };
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
  ): Promise<ToolExecutionResult> {
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
