import {
  FileOperationError,
  type FileOperationErrorCode,
} from "../runtime/textFile.js";
import type { ToolExecutionResult } from "./base.js";

export function fileOperationFailure(
  error: unknown,
): ToolExecutionResult | never {
  if (!(error instanceof FileOperationError)) {
    throw error;
  }

  const details =
    error.code === "internal_error"
      ? { reason: error.details.reason }
      : error.details;

  return {
    ok: false,
    content: errorMessage(error.code, details),
    data: {
      code: error.code,
      retryable: error.retryable,
      details,
    },
  };
}

function errorMessage(
  code: FileOperationErrorCode,
  details: Record<string, unknown>,
): string {
  const reason = String(details.reason ?? "");

  if (code === "conflict") {
    return [
      "File conflict detected; no replacement was published.",
      "Read the file again and retry with its latest sha256 as expected_hash.",
      reason ? `Reason: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return {
    not_found: "File not found. Check the path and read it again.",
    output_limit: "File exceeds the supported text-file byte limit.",
    invalid_encoding: "File is not valid UTF-8 and was not modified.",
    binary_file: "Binary files are not supported and were not modified.",
    permission_denied: "File operation denied by the filesystem.",
    internal_error: "File operation failed before a safe result was published.",
  }[code];
}
