import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { acquireFileLock } from "../runtime/fileLock.js";
import type { SessionEvent, SessionEventInput } from "./types.js";

const appendQueues = new Map<string, Promise<unknown>>();
const MAX_SESSION_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;

interface SessionFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export class SessionStore {
  private readonly sessionId: string;
  private cachedEvents?: SessionEvent[];
  private cachedIdentity?: SessionFileIdentity;

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
    const releaseAppendLock = await acquireFileLock(this.filePath, {
      lockPath: `${this.filePath}.append.lock`,
      label: "session append",
    });
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
        const cacheCurrent = this.cacheMatches(fileInfo);
        if (!cacheCurrent) {
          this.cachedEvents = undefined;
          this.cachedIdentity = undefined;
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
        const serialized = `${prefix}${JSON.stringify(fullEvent)}\n`;
        const serializedBytes = Buffer.byteLength(serialized, "utf8");
        const currentSize = (await handle.stat()).size;
        if (serializedBytes > MAX_SESSION_RECORD_BYTES) {
          throw new Error("Session record exceeds the 16 MiB safety limit.");
        }
        if (currentSize + serializedBytes > MAX_SESSION_FILE_BYTES) {
          throw new Error("Session log exceeds the 256 MiB safety limit.");
        }
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
        const finalInfo = await handle.stat();
        if (cacheCurrent && this.cachedEvents) {
          this.cachedEvents.push(fullEvent);
          this.cachedIdentity = identityOf(finalInfo);
        } else if (sequence === 0) {
          this.cachedEvents = [fullEvent];
          this.cachedIdentity = identityOf(finalInfo);
        }
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
      const initial = await lstat(this.filePath);
      if (this.cacheMatches(initial) && this.cachedEvents) {
        return [...this.cachedEvents];
      }
      const { text, identity } = await readSafeSessionSnapshot(this.filePath);
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

      this.cachedEvents = events;
      this.cachedIdentity = identity;
      return [...events];
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

  private cacheMatches(info: SessionFileIdentity): boolean {
    return (
      this.cachedIdentity !== undefined &&
      this.cachedIdentity.dev === info.dev &&
      this.cachedIdentity.ino === info.ino &&
      this.cachedIdentity.size === info.size &&
      this.cachedIdentity.mtimeMs === info.mtimeMs &&
      this.cachedIdentity.ctimeMs === info.ctimeMs
    );
  }
}

async function readLastSequence(handle: FileHandle): Promise<number> {
  const info = await handle.stat();
  let end = info.size;
  const lastByte = Buffer.alloc(1);
  while (end > 0) {
    await handle.read(lastByte, 0, 1, end - 1);
    if (lastByte[0] !== 0x0a && lastByte[0] !== 0x0d) {
      break;
    }
    end -= 1;
  }
  if (end === 0) {
    return 0;
  }

  const chunks: Buffer[] = [];
  let recordBytes = 0;
  let position = end;
  while (position > 0) {
    const readSize = Math.min(64 * 1024, position);
    const start = position - readSize;
    const chunk = Buffer.allocUnsafe(readSize);
    await handle.read(chunk, 0, readSize, start);
    const newline = chunk.lastIndexOf(0x0a);
    const recordChunk =
      newline === -1 ? chunk : chunk.subarray(newline + 1);
    chunks.unshift(recordChunk);
    recordBytes += recordChunk.length;
    if (recordBytes > MAX_SESSION_RECORD_BYTES) {
      throw new Error("Session record exceeds the 16 MiB safety limit.");
    }
    if (newline !== -1 || start === 0) {
      break;
    }
    position = start;
  }

  const parsed = JSON.parse(Buffer.concat(chunks, recordBytes).toString("utf8")) as {
    sequence?: unknown;
  };
  if (
    typeof parsed.sequence === "number" &&
    Number.isSafeInteger(parsed.sequence) &&
    parsed.sequence > 0
  ) {
    return parsed.sequence;
  }
  return readLegacyLastSequence(handle);
}

async function readLegacyLastSequence(handle: FileHandle): Promise<number> {
  const text = await handle.readFile({ encoding: "utf8" });
  return countRecords(text.split("\n"));
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

async function readSafeSessionSnapshot(
  filePath: string,
): Promise<{ text: string; identity: SessionFileIdentity }> {
  const pathInfo = await lstat(filePath);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error("Refusing to read a symbolic link or non-file session path.");
  }
  if (pathInfo.size > MAX_SESSION_FILE_BYTES) {
    throw new Error("Session log exceeds the 256 MiB safety limit.");
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
      !sameFile(currentPathInfo, fileInfo) ||
      fileInfo.size > MAX_SESSION_FILE_BYTES
    ) {
      throw new Error("Refusing to read a symbolic link or replaced session file.");
    }
    const text = await handle.readFile("utf8");
    const finalInfo = await handle.stat();
    if (
      finalInfo.dev !== fileInfo.dev ||
      finalInfo.ino !== fileInfo.ino ||
      finalInfo.size !== fileInfo.size
    ) {
      throw new Error("Session file changed while it was being read.");
    }
    return { text, identity: identityOf(finalInfo) };
  } finally {
    await handle.close();
  }
}

function identityOf(info: SessionFileIdentity): SessionFileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}
