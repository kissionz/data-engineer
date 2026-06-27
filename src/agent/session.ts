import { randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionEvent, SessionEventInput } from "./types.js";

const appendQueues = new Map<string, Promise<unknown>>();
const ownedAppendLocks = new Map<string, string>();

export class SessionStore {
  private readonly sessionId: string;

  constructor(
    private readonly filePath: string,
    sessionId = inferSessionId(filePath),
    private readonly onAppend?: (event: SessionEvent) => Promise<void>,
  ) {
    this.sessionId = sessionId;
  }

  async append(event: SessionEventInput): Promise<SessionEvent> {
    const queueKey = resolve(this.filePath);
    const previous = appendQueues.get(queueKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.appendNow(event));
    appendQueues.set(queueKey, operation);

    try {
      const appended = await operation;
      await this.onAppend?.(appended).catch(() => undefined);
      return appended;
    } finally {
      if (appendQueues.get(queueKey) === operation) {
        appendQueues.delete(queueKey);
      }
    }
  }

  private async appendNow(event: SessionEventInput): Promise<SessionEvent> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseAppendLock = await acquireAppendLock(this.filePath);
    let committed = false;

    try {
      const handle = await open(this.filePath, "a+", 0o600);

      try {
        const [pathInfo, fileInfo] = await Promise.all([
          lstat(this.filePath),
          handle.stat(),
        ]);
        if (
          pathInfo.isSymbolicLink() ||
          !pathInfo.isFile() ||
          !sameFile(pathInfo, fileInfo)
        ) {
          throw new Error(
            "Refusing to append to a symbolic link or replaced session file.",
          );
        }

        const prefix = await repairUnterminatedTail(handle);
        const sequence = await readLastSequence(handle);
        const timestamp = new Date().toISOString();
        const fullEvent = {
          eventId: randomUUID(),
          sequence: sequence + 1,
          sessionId: this.sessionId,
          timestamp,
          ts: timestamp,
          ...event,
        } as SessionEvent;
        await handle.writeFile(`${prefix}${JSON.stringify(fullEvent)}\n`, "utf8");
        await handle.sync();
        committed = true;
        return fullEvent;
      } finally {
        await handle.close();
      }
    } finally {
      try {
        await releaseAppendLock();
      } catch (error: unknown) {
        if (!committed) {
          throw error;
        }
      }
    }
  }

  async load(): Promise<SessionEvent[]> {
    try {
      const text = await readSafeSessionFile(this.filePath);
      const lines = text.split("\n");
      const events: SessionEvent[] = [];

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line) {
          continue;
        }

        try {
          events.push(
            normalizeEvent(
              JSON.parse(line) as Record<string, unknown>,
              events.length + 1,
              this.sessionId,
            ),
          );
        } catch (error: unknown) {
          const isUnterminatedTail =
            index === lines.length - 1 && !text.endsWith("\n");
          if (isUnterminatedTail) {
            break;
          }
          throw error;
        }
      }

      return events;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }

      throw error;
    }
  }
}

interface AppendLock {
  pid: number;
  hostname: string;
  createdAt: string;
  token: string;
}

async function acquireAppendLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.append.lock`;
  const deadline = Date.now() + 10_000;

  while (true) {
    const lock: AppendLock = {
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
      token: randomBytes(16).toString("hex"),
    };

    try {
      await writeFile(lockPath, `${JSON.stringify(lock)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      ownedAppendLocks.set(lockPath, lock.token);
      return async () => {
        await removeOwnedAppendLock(lockPath, lock.token);
      };
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
      const locallyOwned = ownedAppendLocks.get(lockPath);
      if (
        (locallyOwned &&
          (await removeOwnedAppendLock(lockPath, locallyOwned).catch(
            () => false,
          ))) ||
        (await removeStaleAppendLock(lockPath))
      ) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for session append lock: ${filePath}`);
      }
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
}

async function readAppendLock(lockPath: string): Promise<AppendLock> {
  const parsed = JSON.parse(
    await readSafeSessionFile(lockPath),
  ) as Partial<AppendLock>;

  if (
    !Number.isInteger(parsed.pid) ||
    typeof parsed.hostname !== "string" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.token !== "string"
  ) {
    throw new Error("Session append lock is invalid.");
  }
  return parsed as AppendLock;
}

async function removeStaleAppendLock(lockPath: string): Promise<boolean> {
  let lock: AppendLock;
  try {
    lock = await readAppendLock(lockPath);
  } catch {
    return removeAgedInvalidLock(lockPath);
  }

  if (lock.hostname !== hostname() || isProcessAlive(lock.pid)) {
    return false;
  }
  const current = await readAppendLock(lockPath).catch(() => null);
  if (!current || current.token !== lock.token) {
    return false;
  }
  await unlinkWithRetry(lockPath);
  return true;
}

async function removeOwnedAppendLock(
  lockPath: string,
  token: string,
): Promise<boolean> {
  try {
    const current = await readAppendLock(lockPath);
    if (current.token === token) {
      await unlinkWithRetry(lockPath);
      if (ownedAppendLocks.get(lockPath) === token) {
        ownedAppendLocks.delete(lockPath);
      }
      return true;
    }
    return false;
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      if (ownedAppendLocks.get(lockPath) === token) {
        ownedAppendLocks.delete(lockPath);
      }
      return true;
    }
    throw error;
  }
}

async function removeAgedInvalidLock(lockPath: string): Promise<boolean> {
  let first: Stats;
  try {
    first = await lstat(lockPath);
  } catch {
    return false;
  }
  if (
    first.isSymbolicLink() ||
    !first.isFile() ||
    Date.now() - first.mtimeMs < 30_000
  ) {
    return false;
  }
  const current = await lstat(lockPath).catch(() => null);
  if (!current || !sameFile(first, current) || current.mtimeMs !== first.mtimeMs) {
    return false;
  }
  await unlinkWithRetry(lockPath);
  return true;
}

async function unlinkWithRetry(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await unlink(filePath);
      return;
    } catch (error: unknown) {
      if (
        attempt === 4 ||
        (!hasCode(error, "EPERM") &&
          !hasCode(error, "EACCES") &&
          !hasCode(error, "EBUSY"))
      ) {
        throw error;
      }
      await delay(10 * (attempt + 1));
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function readLastSequence(handle: FileHandle): Promise<number> {
  const text = await handle.readFile({ encoding: "utf8" });
  const lines = text.split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const parsed = JSON.parse(line) as { sequence?: unknown };
    return typeof parsed.sequence === "number" &&
      Number.isSafeInteger(parsed.sequence) &&
      parsed.sequence > 0
      ? parsed.sequence
      : countRecords(lines.slice(0, index + 1));
  }

  return 0;
}

function countRecords(lines: string[]): number {
  return lines.reduce((count, line) => count + (line ? 1 : 0), 0);
}

function normalizeEvent(
  event: Record<string, unknown>,
  fallbackSequence: number,
  sessionId: string,
): SessionEvent {
  const sequence =
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0
      ? event.sequence
      : fallbackSequence;
  const timestamp =
    typeof event.timestamp === "string"
      ? event.timestamp
      : typeof event.ts === "string"
        ? event.ts
        : new Date(0).toISOString();

  return {
    ...event,
    eventId:
      typeof event.eventId === "string"
        ? event.eventId
        : `legacy-${sessionId}-${sequence}`,
    sequence,
    sessionId:
      typeof event.sessionId === "string" ? event.sessionId : sessionId,
    timestamp,
    ts: typeof event.ts === "string" ? event.ts : timestamp,
  } as SessionEvent;
}

function inferSessionId(filePath: string): string {
  const name = basename(filePath);
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
}

async function repairUnterminatedTail(handle: FileHandle): Promise<string> {
  const info = await handle.stat();

  if (info.size === 0) {
    return "";
  }

  const maxTailBytes = 1024 * 1024;
  const readSize = Math.min(info.size, maxTailBytes);
  const buffer = Buffer.alloc(readSize);
  await handle.read(buffer, 0, readSize, info.size - readSize);

  if (buffer.at(-1) === 0x0a) {
    return "";
  }

  const lastNewline = buffer.lastIndexOf(0x0a);

  if (lastNewline === -1 && info.size > maxTailBytes) {
    throw new Error("Unterminated session record exceeds the recovery limit.");
  }

  const fragment = buffer.subarray(lastNewline + 1).toString("utf8");

  try {
    JSON.parse(fragment);
    return "\n";
  } catch {
    const fragmentStart = info.size - readSize + lastNewline + 1;
    await handle.truncate(fragmentStart);
    return "";
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readSafeSessionFile(filePath: string): Promise<string> {
  const pathInfo = await lstat(filePath);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error("Refusing to read a symbolic link or non-file session path.");
  }

  const handle = await open(filePath, "r");
  try {
    const [currentPathInfo, fileInfo] = await Promise.all([
      lstat(filePath),
      handle.stat(),
    ]);
    if (
      currentPathInfo.isSymbolicLink() ||
      !currentPathInfo.isFile() ||
      !sameFile(currentPathInfo, fileInfo)
    ) {
      throw new Error("Refusing to read a symbolic link or replaced session file.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
