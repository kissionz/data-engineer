import { readFile, stat } from "node:fs/promises";
import type { Workspace } from "../runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "./base.js";

export class ReadTool implements Tool {
  name = "Read";
  description = "Read a text file from the workspace.";

  inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["file_path"],
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (typeof args.file_path !== "string") {
      return { ok: false, content: "file_path must be a string." };
    }

    const filePath = args.file_path;
    const absPath = this.workspace.resolve(filePath);
    const info = await stat(absPath).catch(() => null);

    if (!info) {
      return { ok: false, content: `File not found: ${filePath}` };
    }

    if (!info.isFile()) {
      return { ok: false, content: `Not a file: ${filePath}` };
    }

    await this.workspace.assertRealPathWithin(absPath);

    const text = await readFile(absPath, "utf8");
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
