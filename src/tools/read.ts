import {
  DEFAULT_MAX_TEXT_FILE_BYTES,
  readTextFileSnapshot,
} from "../runtime/textFile.js";
import type { Workspace } from "../runtime/workspace.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";
import { fileOperationFailure } from "./fileErrors.js";

export class ReadTool implements Tool {
  name = "Read";
  description =
    "Read a UTF-8 text file. Absolute paths outside the workspace may be requested and will use the folder approval flow.";

  inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["file_path"],
    additionalProperties: false,
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly maxFileBytes = DEFAULT_MAX_TEXT_FILE_BYTES,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (typeof args.file_path !== "string") {
      return { ok: false, content: "file_path must be a string." };
    }

    const filePath = args.file_path;
    let snapshot;

    try {
      snapshot = await readTextFileSnapshot(this.workspace, filePath, {
        maxBytes: this.maxFileBytes,
        allowOutside: context?.userApproved === true,
        outsideRoot: context?.approvedFolder,
        signal: context?.signal,
      });
    } catch (error: unknown) {
      return fileOperationFailure(error);
    }

    const text = snapshot.text;
    const lines = text.split(/\r?\n/);
    const offset = integerArg(args.offset, 0, 0);
    const limit = integerArg(args.limit, 300, 1);
    const selected = lines.slice(offset, offset + limit);

    const numbered = selected
      .map((line, index) => {
        const lineNo = String(offset + index + 1).padStart(5, " ");
        return `${lineNo} | ${line}`;
      })
      .join("\n");

    const truncated = offset + limit < lines.length;

    return {
      ok: true,
      content: numbered + (truncated ? "\n\n[Output truncated]" : ""),
      data: {
        path: filePath,
        sha256: snapshot.hash,
        size: snapshot.size,
        encoding: "utf-8",
        bom: snapshot.bom,
        lineEnding: snapshot.lineEnding,
        mode: snapshot.mode,
        totalLines: lines.length,
        offset,
        limit,
        truncated,
      },
    };
  }
}

function integerArg(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.floor(value));
}
