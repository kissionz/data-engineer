import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { throwIfCancelled } from "../agent/cancellation.js";

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export async function* walkSearchFiles(
  root: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo || rootInfo.isSymbolicLink()) {
    return;
  }
  if (rootInfo.isFile()) {
    if (!isSensitiveEnvFile(path.basename(root))) {
      yield root;
    }
    return;
  }

  const pending = [root];

  while (pending.length > 0) {
    throwIfCancelled(signal);
    const directory = pending.pop();
    if (!directory) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      throwIfCancelled(signal);
      const entry = entries[index];
      if (!entry || entry.isSymbolicLink()) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          pending.push(absolutePath);
        }
        continue;
      }

      if (entry.isFile() && !isSensitiveEnvFile(entry.name)) {
        yield absolutePath;
      }
    }
  }
}

export function matchesGlob(
  root: string,
  absolutePath: string,
  pattern: string,
): boolean {
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  const normalizedPattern = pattern.replaceAll("\\", "/");
  return path.matchesGlob(relativePath, normalizedPattern);
}

function isSensitiveEnvFile(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.");
}
