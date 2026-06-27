import { readFile, stat, writeFile } from "node:fs/promises";
import type { Workspace } from "../runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "./base.js";

function unifiedDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    "@@ simplified @@",
    ...oldLines
      .map((line, index) => (line !== newLines[index] ? `- ${line}` : null))
      .filter((line): line is string => line !== null),
    ...newLines
      .map((line, index) => (line !== oldLines[index] ? `+ ${line}` : null))
      .filter((line): line is string => line !== null),
  ].join("\n");
}

export class EditTool implements Tool {
  name = "Edit";
  description = "Replace an exact string in a text file.";

  inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (
      typeof args.file_path !== "string" ||
      typeof args.old_string !== "string" ||
      typeof args.new_string !== "string"
    ) {
      return {
        ok: false,
        content: "file_path, old_string, and new_string must be strings.",
      };
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

    const content = await readFile(absPath, "utf8");
    const count = content.split(args.old_string).length - 1;

    if (count === 0) {
      return {
        ok: false,
        content: "old_string not found. Read the file again before editing.",
        data: { reason: "old_string_not_found" },
      };
    }

    if (count > 1) {
      return {
        ok: false,
        content: `old_string matched ${count} times. Provide a more specific old_string.`,
        data: { reason: "old_string_not_unique", count },
      };
    }

    const newContent = content.replace(args.old_string, args.new_string);
    await writeFile(absPath, newContent, "utf8");

    const diff = unifiedDiff(content, newContent, filePath);

    return {
      ok: true,
      content: `Edited ${filePath}:\n\n${diff}`,
      data: { path: filePath, diff },
    };
  }
}
