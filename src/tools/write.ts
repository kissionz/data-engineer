import { throwIfCancelled } from "../agent/cancellation.js";
import { atomicCreateTextFile } from "../runtime/textFile.js";
import type { Workspace } from "../runtime/workspace.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";
import { fileOperationFailure } from "./fileErrors.js";

export class WriteTool implements Tool {
  name = "Write";
  description =
    "Atomically create a UTF-8 text file in an existing workspace directory. Existing files cannot be overwritten.";

  inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    throwIfCancelled(context?.signal);
    if (typeof args.file_path !== "string" || typeof args.content !== "string") {
      return {
        ok: false,
        content: "file_path and content must be strings.",
      };
    }

    const filePath = args.file_path;

    try {
      throwIfCancelled(context?.signal);
      const created = await atomicCreateTextFile(
        this.workspace,
        filePath,
        args.content,
        {
          allowOutside: context?.userApproved === true,
          outsideRoot: context?.approvedFolder,
          signal: context?.signal,
        },
      );

      return {
        ok: true,
        content: `Created file: ${filePath}`,
        data: {
          operation: "create",
          path: filePath,
          sha256: created.hash,
          size: created.size,
          lineEnding: created.lineEnding,
          mode: created.mode,
          bom: created.bom,
        },
      };
    } catch (error: unknown) {
      return fileOperationFailure(error);
    }
  }
}
