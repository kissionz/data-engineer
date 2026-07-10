import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { userStateRoot } from "../runtime/productPaths.js";

export interface MemoryPaths {
  project: string;
  user: string;
}

export function memoryPathsForWorkspace(
  workspaceRoot: string,
  userHome = homedir(),
): MemoryPaths {
  const identity = createHash("sha256")
    .update(normalizeWorkspaceIdentity(workspaceRoot))
    .digest("hex");
  const memoryRoot = path.join(userStateRoot(userHome), "memory");

  return {
    project: path.join(memoryRoot, "projects", `${identity}.jsonl`),
    user: path.join(memoryRoot, "user.jsonl"),
  };
}

function normalizeWorkspaceIdentity(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
