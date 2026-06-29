import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { z } from "zod";

const MAX_JSON_BYTES = 1024 * 1024;

export async function readSafeJson<T>(
  workspaceRoot: string,
  relativePath: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const root = await realpath(workspaceRoot);
  const filePath = resolveSafeRelativePath(root, relativePath);
  const initial = await lstat(filePath);
  assertRegularBoundedFile(initial);

  const handle = await open(
    filePath,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const [pathInfo, handleInfo, resolvedFile] = await Promise.all([
      lstat(filePath),
      handle.stat(),
      realpath(filePath),
    ]);
    assertSameFile(pathInfo, handleInfo);
    assertContained(root, resolvedFile);
    const text = await readBounded(handle);
    const finalPathInfo = await lstat(filePath);
    assertSameFile(finalPathInfo, handleInfo);

    try {
      return schema.parse(JSON.parse(text) as unknown);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw new Error(`Eval JSON is invalid: ${error.message}`);
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function writeSafeJson(
  workspaceRoot: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const root = await realpath(workspaceRoot);
  const filePath = resolveSafeRelativePath(root, relativePath);
  const parent = path.dirname(filePath);
  await ensureSafeParent(root, parent);

  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Refusing a symbolic link or non-file eval report.");
    }
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }

  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) {
    throw new Error("Eval report exceeds the 1 MiB safety limit.");
  }

  const temporaryPath = path.join(
    parent,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let renamed = false;
  try {
    await handle.writeFile(json, "utf8");
    await handle.sync();
    await handle.close();
    assertContained(root, await realpath(parent));
    await rename(temporaryPath, filePath);
    renamed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export function resolveSafeRelativePath(
  workspaceRoot: string,
  relativePath: string,
): string {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.length > 4_000 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw new Error("Eval paths must be non-empty relative paths.");
  }
  const resolved = path.resolve(workspaceRoot, relativePath);
  assertContained(path.resolve(workspaceRoot), resolved);
  return resolved;
}

function assertContained(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Eval path escapes the workspace root.");
  }
}

async function ensureSafeParent(root: string, parent: string): Promise<void> {
  const relative = path.relative(root, parent);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Refusing an unsafe eval report directory.");
      }
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("Eval report directory changed while it was created.");
      }
    }
    assertContained(root, await realpath(current));
  }
}

function assertRegularBoundedFile(info: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Refusing a symbolic link or non-file eval input.");
  }
  if (info.size > MAX_JSON_BYTES) {
    throw new Error("Eval input exceeds the 1 MiB safety limit.");
  }
}

function assertSameFile(
  pathInfo: {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    dev: number;
    ino: number;
  },
  handleInfo: {
    isFile(): boolean;
    size: number;
    dev: number;
    ino: number;
  },
): void {
  if (
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    !handleInfo.isFile() ||
    pathInfo.dev !== handleInfo.dev ||
    pathInfo.ino !== handleInfo.ino
  ) {
    throw new Error("Eval input changed while it was being opened.");
  }
  if (pathInfo.size > MAX_JSON_BYTES || handleInfo.size > MAX_JSON_BYTES) {
    throw new Error("Eval input exceeds the 1 MiB safety limit.");
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_JSON_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > MAX_JSON_BYTES) {
    throw new Error("Eval input exceeds the 1 MiB safety limit.");
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
