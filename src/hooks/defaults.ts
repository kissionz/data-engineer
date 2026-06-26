import path from "node:path";
import type { ToolCall } from "../agent/types.js";
import type { HookResult } from "./types.js";

export function protectSensitiveWrites(
  payload: Record<string, unknown>,
): HookResult | null {
  const call = payload.toolCall as ToolCall | undefined;

  if (!call || !["Edit", "Write"].includes(call.name)) {
    return null;
  }

  const filePath = String(call.args.file_path ?? "").replaceAll("\\", "/");
  const segments = path.posix.normalize(filePath).split("/").filter(Boolean);
  const sensitive = segments.some(
    (segment) =>
      segment === ".git" ||
      segment === "node_modules" ||
      segment === ".env" ||
      segment.startsWith(".env."),
  );

  if (sensitive) {
    return {
      decision: "block",
      reason: "Writes to sensitive project paths are blocked.",
      data: { filePath },
    };
  }

  const content =
    call.name === "Write" ? call.args.content : call.args.new_string;

  if (typeof content === "string" && content.length > 1_000_000) {
    return {
      decision: "block",
      reason: "A single file write cannot exceed 1,000,000 characters.",
      data: { filePath, length: content.length },
    };
  }

  return null;
}
