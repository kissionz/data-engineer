import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

interface LockRecord {
  pid: number;
  hostname: string;
  createdAt: string;
  token: string;
}

export interface FileLockOptions {
  lockPath?: string;
  timeoutMs?: number;
  staleMs?: number;
  label?: string;
}

export async function acquireFileLock(
  targetPath: string,
  options: FileLockOptions = {},
): Promise<() => Promise<void>> {
  const lockPath = options.lockPath ?? `${targetPath}.lock`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const label = options.label ?? "file";
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const record: LockRecord = {
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
      token: randomBytes(16).toString("hex"),
    };
    try {
      await writeFile(lockPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return async () => {
        await releaseFileLock(lockPath, record.token);
      };
    } catch (error: unknown) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (
        await removeStaleLock(lockPath, staleMs)
      ) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${label} lock: ${targetPath}`);
      }
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
}

async function releaseFileLock(
  lockPath: string,
  token: string,
): Promise<boolean> {
  try {
    const current = await readLock(lockPath);
    if (current.token !== token) {
      return false;
    }
    await unlinkWithRetry(lockPath);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

async function removeStaleLock(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  let record: LockRecord;
  try {
    record = await readLock(lockPath);
  } catch {
    return removeAgedInvalidLock(lockPath, staleMs);
  }
  if (record.hostname !== hostname() || isProcessAlive(record.pid)) {
    return false;
  }
  const current = await readLock(lockPath).catch(() => undefined);
  if (!current || current.token !== record.token) {
    return false;
  }
  await unlinkWithRetry(lockPath);
  return true;
}

async function removeAgedInvalidLock(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  const first = await lstat(lockPath).catch(() => undefined);
  if (
    !first ||
    first.isSymbolicLink() ||
    !first.isFile() ||
    Date.now() - first.mtimeMs < staleMs
  ) {
    return false;
  }
  const current = await lstat(lockPath).catch(() => undefined);
  if (
    !current ||
    current.dev !== first.dev ||
    current.ino !== first.ino ||
    current.mtimeMs !== first.mtimeMs
  ) {
    return false;
  }
  await unlinkWithRetry(lockPath);
  return true;
}

async function readLock(lockPath: string): Promise<LockRecord> {
  const initial = await lstat(lockPath);
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.size > 1_024
  ) {
    throw new Error("Lock path is not a safe regular file.");
  }
  const handle = await open(
    lockPath,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    await assertSameFile(lockPath, handle, initial.dev, initial.ino);
    const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<LockRecord>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.token !== "string"
    ) {
      throw new Error("Lock record is invalid.");
    }
    return parsed as LockRecord;
  } finally {
    await handle.close();
  }
}

async function assertSameFile(
  lockPath: string,
  handle: FileHandle,
  expectedDevice: number,
  expectedInode: number,
): Promise<void> {
  const [current, opened] = await Promise.all([
    lstat(lockPath),
    handle.stat(),
  ]);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== expectedDevice ||
    current.ino !== expectedInode ||
    opened.dev !== expectedDevice ||
    opened.ino !== expectedInode
  ) {
    throw new Error("Lock file changed while it was being opened.");
  }
}

async function unlinkWithRetry(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await unlink(filePath);
      return;
    } catch (error: unknown) {
      if (
        attempt === 4 ||
        !["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "")
      ) {
        throw error;
      }
      await delay(10 * (attempt + 1));
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}
