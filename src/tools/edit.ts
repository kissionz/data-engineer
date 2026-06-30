import { throwIfCancelled } from "../agent/cancellation.js";
import { unifiedDiff } from "../runtime/diff.js";
import {
  FileOperationError,
  atomicReplaceTextFile,
  readTextFileSnapshot,
} from "../runtime/textFile.js";
import type { Workspace } from "../runtime/workspace.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";
import { fileOperationFailure } from "./fileErrors.js";

export class EditTool implements Tool {
  name = "Edit";
  description =
    "Atomically replace an exact string in a UTF-8 text file. Pass the sha256 from Read as expected_hash.";

  inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string", minLength: 1 },
      new_string: { type: "string" },
      expected_hash: {
        type: "string",
        pattern: "^[A-Fa-f0-9]{64}$",
      },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    throwIfCancelled(context?.signal);
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

    try {
      const snapshot = await readTextFileSnapshot(this.workspace, filePath, {
        forEdit: true,
        allowOutside: context?.userApproved === true,
        outsideRoot: context?.approvedFolder,
        signal: context?.signal,
      });
      const expectedHash =
        typeof args.expected_hash === "string"
          ? args.expected_hash.toLowerCase()
          : undefined;

      if (expectedHash && expectedHash !== snapshot.hash) {
        throw new FileOperationError("conflict", true, {
          path: filePath,
          reason: "expected_hash_mismatch",
          expectedHash,
          actualHash: snapshot.hash,
        });
      }

      const oldString = adaptLineEndings(
        args.old_string,
        snapshot.lineEnding,
      );
      const newString = adaptLineEndings(
        args.new_string,
        snapshot.lineEnding,
      );
      const content = snapshot.text;
      const count = content.split(oldString).length - 1;

      if (count === 0) {
        return {
          ok: false,
          content: "old_string not found. Read the file again before editing.",
          data: {
            code: "conflict",
            retryable: true,
            details: { reason: "old_string_not_found" },
          },
        };
      }

      if (count > 1) {
        return {
          ok: false,
          content: `old_string matched ${count} times. Provide a more specific old_string.`,
          data: {
            code: "conflict",
            retryable: true,
            details: { reason: "old_string_not_unique", count },
          },
        };
      }

      const newContent = content.replace(oldString, newString);
      throwIfCancelled(context?.signal);
      const updated = await atomicReplaceTextFile(snapshot, newContent, {
        signal: context?.signal,
      });

      const diff = unifiedDiff(content, newContent, filePath);

      return {
        ok: true,
        content: `Edited ${filePath}:\n\n${diff}`,
        data: {
          path: filePath,
          diff,
          previousSha256: snapshot.hash,
          sha256: updated.hash,
          size: updated.size,
          lineEnding: updated.lineEnding,
          mode: updated.mode,
          bom: updated.bom,
        },
      };
    } catch (error: unknown) {
      return fileOperationFailure(error);
    }
  }
}

function adaptLineEndings(
  value: string,
  lineEnding: "none" | "lf" | "crlf" | "mixed",
): string {
  if (lineEnding === "crlf") {
    return value.replace(/\r\n|\r|\n/g, "\r\n");
  }

  if (lineEnding === "lf") {
    return value.replace(/\r\n/g, "\n");
  }

  return value;
}
