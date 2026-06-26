import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../runtime/workspace.js";
import type { Tool, ToolExecutionResult } from "./base.js";

export class WriteTool implements Tool {
  name = "Write";
  description = "Create a new text file. Existing files cannot be overwritten.";

  inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (typeof args.file_path !== "string" || typeof args.content !== "string") {
      return {
        ok: false,
        content: "file_path and content must be strings.",
      };
    }

    const filePath = args.file_path;
    const absPath = this.workspace.resolve(filePath);
    const exists = await stat(absPath).then(
      () => true,
      () => false,
    );

    if (exists) {
      return {
        ok: false,
        content: `File already exists: ${filePath}. Use Edit to update it.`,
        data: { reason: "file_exists", path: filePath },
      };
    }

    await this.workspace.assertCreatablePathWithin(absPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, args.content, { encoding: "utf8", flag: "wx" });

    return {
      ok: true,
      content: `Created file: ${filePath}`,
      data: { operation: "create", path: filePath },
    };
  }
}
