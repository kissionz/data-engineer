import { randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MemoryValidationError,
  type MemoryRecord,
  type MemoryScope,
} from "./types.js";

const MAX_STORE_BYTES = 16 * 1024 * 1024;
const appendQueues = new Map<string, Promise<unknown>>();

interface MemoryEventEnvelope {
  eventId: string;
  sequence: number;
  timestamp: string;
  event: MemoryEvent;
}

type MemoryEvent =
  | { type: "upsert"; record: MemoryRecord }
  | {
      type: "supersede";
      previousId: string;
      record: MemoryRecord;
    }
  | {
      type: "delete";
      id: string;
      reason: string;
      deletedAt: string;
    };

export class MemoryStore {
  constructor(
    private readonly filePath: string,
    readonly scope: MemoryScope,
  ) {}

  async list(): Promise<MemoryRecord[]> {
    const records = new Map<string, MemoryRecord>();

    for (const envelope of await this.loadEvents()) {
      const event = envelope.event;
      if (event.type === "upsert") {
        records.set(event.record.id, event.record);
      } else if (event.type === "supersede") {
        const previous = records.get(event.previousId);
        if (!previous || previous.status !== "active") {
          throw new MemoryValidationError(
            `Memory ${event.previousId} cannot be superseded from the current log state.`,
          );
        }
        records.set(event.previousId, {
          ...previous,
          status: "superseded",
          updatedAt: envelope.timestamp,
        });
        records.set(event.record.id, event.record);
      } else {
        const existing = records.get(event.id);
        if (!existing) {
          throw new MemoryValidationError(
            `Memory ${event.id} cannot be deleted because it does not exist.`,
          );
        }
        records.set(event.id, {
          ...existing,
          status: "deleted",
          updatedAt: event.deletedAt,
        });
      }
    }

    return [...records.values()];
  }

  async listActive(now = new Date()): Promise<MemoryRecord[]> {
    const timestamp = now.getTime();
    return (await this.list()).filter(
      (record) =>
        record.status === "active" &&
        (!record.expiresAt || Date.parse(record.expiresAt) > timestamp),
    );
  }

  async upsert(record: MemoryRecord): Promise<void> {
    validateMemoryRecord(record, this.scope);
    await this.append({ type: "upsert", record });
  }

  async supersede(previousId: string, record: MemoryRecord): Promise<void> {
    validateId(previousId, "previousId");
    validateMemoryRecord(record, this.scope);
    await this.append({ type: "supersede", previousId, record });
  }

  async delete(id: string, reason: string, deletedAt = new Date()): Promise<void> {
    validateId(id, "id");
    const normalizedReason = validateText(reason, "reason", 1, 500);
    const timestamp = deletedAt.toISOString();
    await this.append({
      type: "delete",
      id,
      reason: normalizedReason,
      deletedAt: timestamp,
    });
  }

  private async append(event: MemoryEvent): Promise<void> {
    const key = path.resolve(this.filePath);
    await serializeMemoryOperation(key, () => this.appendNow(event));
  }

  private async appendNow(event: MemoryEvent): Promise<void> {
    await ensureSafeParent(this.filePath);
    const release = await acquireLock(this.filePath);
    let committed = false;

    try {
      const handle = await open(this.filePath, "a+", 0o600);
      try {
        await assertSafeOpenFile(this.filePath, handle);
        const { events, validBytes, needsNewline } = await readFromHandle(
          handle,
          true,
        );
        const envelope: MemoryEventEnvelope = {
          eventId: randomUUID(),
          sequence: events.length + 1,
          timestamp: new Date().toISOString(),
          event,
        };
        validateEnvelope(envelope, envelope.sequence, this.scope);
        const serializedEnvelope = `${JSON.stringify(envelope)}\n`;
        const appendBytes =
          Buffer.byteLength(serializedEnvelope, "utf8") +
          (needsNewline ? 1 : 0);
        if (validBytes + appendBytes > MAX_STORE_BYTES) {
          throw new Error("Memory store would exceed the 16 MiB safety limit.");
        }

        const fileInfo = await handle.stat();
        if (fileInfo.size !== validBytes) {
          await handle.truncate(validBytes);
        }
        if (needsNewline) {
          await handle.writeFile("\n", "utf8");
        }
        await handle.writeFile(serializedEnvelope, "utf8");
        await handle.sync();
        committed = true;
      } finally {
        await handle.close();
      }
    } finally {
      try {
        await release();
      } catch (error: unknown) {
        if (!committed) {
          throw error;
        }
      }
    }
  }

  private async loadEvents(): Promise<MemoryEventEnvelope[]> {
    try {
      const fileInfo = await lstat(this.filePath);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        throw new Error("Refusing to read a symbolic link or non-file memory store.");
      }
      const handle = await open(this.filePath, "r");
      try {
        await assertSafeOpenFile(this.filePath, handle);
        return (await readFromHandle(handle, false)).events.map(
          (event, index) => validateEnvelope(event, index + 1, this.scope),
        );
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  }
}

export async function withMemoryTransaction<T>(
  transactionPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `transaction:${path.resolve(transactionPath)}`;
  return serializeMemoryOperation(key, async () => {
    await ensureSafeParent(transactionPath);
    const release = await acquireLock(transactionPath);
    try {
      return await operation();
    } finally {
      await release();
    }
  });
}

async function serializeMemoryOperation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  appendQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (appendQueues.get(key) === current) {
      appendQueues.delete(key);
    }
  }
}

async function readFromHandle(
  handle: FileHandle,
  recoverTail: boolean,
): Promise<{
  events: MemoryEventEnvelope[];
  validBytes: number;
  needsNewline: boolean;
}> {
  const fileInfo = await handle.stat();
  if (fileInfo.size > MAX_STORE_BYTES) {
    throw new Error("Memory store exceeds the 16 MiB safety limit.");
  }
  const buffer = Buffer.alloc(fileInfo.size);
  if (buffer.length > 0) {
    await handle.read(buffer, 0, buffer.length, 0);
  }

  const events: MemoryEventEnvelope[] = [];
  let offset = 0;
  let validBytes = 0;
  let needsNewline = false;

  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    const isTail = newline === -1;
    const end = isTail ? buffer.length : newline;
    const line = buffer.subarray(offset, end);
    if (line.length === 0) {
      validBytes = isTail ? end : end + 1;
      offset = end + 1;
      continue;
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      const parsed = JSON.parse(text) as unknown;
      events.push(validateEnvelope(parsed, events.length + 1));
      validBytes = end + (isTail ? 0 : 1);
      needsNewline = isTail;
    } catch (error: unknown) {
      if (recoverTail && isTail) {
        return { events, validBytes, needsNewline: false };
      }
      throw new MemoryValidationError(
        `Memory log contains an invalid event at sequence ${events.length + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    offset = end + 1;
  }

  return { events, validBytes, needsNewline };
}

function validateEnvelope(
  value: unknown,
  expectedSequence: number,
  expectedScope?: MemoryScope,
): MemoryEventEnvelope {
  const record = requireRecord(value, "memory event");
  requireExactKeys(record, ["eventId", "sequence", "timestamp", "event"]);
  validateId(record.eventId, "eventId");
  if (record.sequence !== expectedSequence) {
    throw new MemoryValidationError(
      `Memory event sequence must be ${expectedSequence}.`,
    );
  }
  validateTimestamp(record.timestamp, "timestamp");
  const eventValue = requireRecord(record.event, "event");
  const type = eventValue.type;
  let event: MemoryEvent;

  if (type === "upsert") {
    requireExactKeys(eventValue, ["type", "record"]);
    event = {
      type,
      record: validateMemoryRecord(eventValue.record, expectedScope),
    };
  } else if (type === "supersede") {
    requireExactKeys(eventValue, ["type", "previousId", "record"]);
    validateId(eventValue.previousId, "previousId");
    event = {
      type,
      previousId: eventValue.previousId as string,
      record: validateMemoryRecord(eventValue.record, expectedScope),
    };
  } else if (type === "delete") {
    requireExactKeys(eventValue, ["type", "id", "reason", "deletedAt"]);
    validateId(eventValue.id, "id");
    event = {
      type,
      id: eventValue.id as string,
      reason: validateText(eventValue.reason, "reason", 1, 500),
      deletedAt: validateTimestamp(eventValue.deletedAt, "deletedAt"),
    };
  } else {
    throw new MemoryValidationError("Memory event type is invalid.");
  }

  return {
    eventId: record.eventId as string,
    sequence: record.sequence as number,
    timestamp: record.timestamp as string,
    event,
  };
}

export function validateMemoryRecord(
  value: unknown,
  expectedScope?: MemoryScope,
): MemoryRecord {
  const record = requireRecord(value, "memory record");
  requireExactKeys(
    record,
    [
      "id",
      "scope",
      "kind",
      "content",
      "source",
      "confidence",
      "tags",
      "createdAt",
      "updatedAt",
      "status",
    ],
    ["expiresAt"],
  );
  validateId(record.id, "id");
  if (record.scope !== "project" && record.scope !== "user") {
    throw new MemoryValidationError("scope must be project or user.");
  }
  if (expectedScope && record.scope !== expectedScope) {
    throw new MemoryValidationError(
      `Memory scope ${record.scope} does not match store scope ${expectedScope}.`,
    );
  }
  const kinds = [
    "instruction",
    "preference",
    "project_fact",
    "workflow",
    "warning",
  ];
  if (!kinds.includes(String(record.kind))) {
    throw new MemoryValidationError("kind is invalid.");
  }
  const content = validateText(record.content, "content", 1, 4_000);
  const sourceValue = requireRecord(record.source, "source");
  requireExactKeys(sourceValue, ["type"], ["sessionId", "eventId"]);
  if (!["user", "manifest", "tool_result", "agent"].includes(String(sourceValue.type))) {
    throw new MemoryValidationError("source.type is invalid.");
  }
  if (
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new MemoryValidationError("confidence must be between 0 and 1.");
  }
  if (!Array.isArray(record.tags) || record.tags.length > 20) {
    throw new MemoryValidationError("tags must contain at most 20 strings.");
  }
  const tags = record.tags.map((tag, index) =>
    validateText(tag, `tags[${index}]`, 1, 64).toLowerCase(),
  );
  if (new Set(tags).size !== tags.length) {
    throw new MemoryValidationError("tags must not contain duplicates.");
  }
  const createdAt = validateTimestamp(record.createdAt, "createdAt");
  const updatedAt = validateTimestamp(record.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new MemoryValidationError("updatedAt cannot precede createdAt.");
  }
  let expiresAt: string | undefined;
  if (record.expiresAt !== undefined) {
    expiresAt = validateTimestamp(record.expiresAt, "expiresAt");
  }
  if (!["active", "superseded", "deleted"].includes(String(record.status))) {
    throw new MemoryValidationError("status is invalid.");
  }

  const source: MemoryRecord["source"] = {
    type: sourceValue.type as MemoryRecord["source"]["type"],
  };
  if (sourceValue.sessionId !== undefined) {
    source.sessionId = validateText(sourceValue.sessionId, "source.sessionId", 1, 200);
  }
  if (sourceValue.eventId !== undefined) {
    source.eventId = validateText(sourceValue.eventId, "source.eventId", 1, 200);
  }

  return {
    id: record.id as string,
    scope: record.scope,
    kind: record.kind as MemoryRecord["kind"],
    content,
    source,
    confidence: record.confidence,
    tags,
    createdAt,
    updatedAt,
    ...(expiresAt ? { expiresAt } : {}),
    status: record.status as MemoryRecord["status"],
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryValidationError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new MemoryValidationError(`${key} is required.`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) {
    throw new MemoryValidationError(`${extra} is not allowed.`);
  }
}

function validateId(value: unknown, name: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new MemoryValidationError(`${name} is invalid.`);
  }
}

function validateText(
  value: unknown,
  name: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") {
    throw new MemoryValidationError(`${name} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new MemoryValidationError(
      `${name} must contain between ${min} and ${max} characters.`,
    );
  }
  if (normalized.includes("\0")) {
    throw new MemoryValidationError(`${name} cannot contain NUL bytes.`);
  }
  return normalized;
}

function validateTimestamp(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new MemoryValidationError(`${name} must be an ISO timestamp.`);
  }
  return value;
}

async function ensureSafeParent(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

async function assertSafeOpenFile(filePath: string, handle: FileHandle): Promise<void> {
  const [pathInfo, handleInfo] = await Promise.all([
    lstat(filePath),
    handle.stat(),
  ]);
  if (
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    pathInfo.dev !== handleInfo.dev ||
    pathInfo.ino !== handleInfo.ino
  ) {
    throw new Error("Refusing a symbolic link or replaced memory store.");
  }
}

interface LockData {
  pid: number;
  hostname: string;
  createdAt: string;
  token: string;
}

async function acquireLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 10_000;

  while (true) {
    const data: LockData = {
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
      token: randomBytes(16).toString("hex"),
    };
    try {
      await writeFile(lockPath, `${JSON.stringify(data)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return () => releaseLock(lockPath, data.token);
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
      if (await removeStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for memory lock: ${filePath}`);
      }
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = await readLock(lockPath);
    if (current.token === token) {
      await unlink(lockPath);
    }
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lock = await readLock(lockPath);
    if (lock.hostname !== hostname() || isProcessAlive(lock.pid)) {
      return false;
    }
    const current = await readLock(lockPath);
    if (current.token !== lock.token) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch {
    try {
      const info = await lstat(lockPath);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        Date.now() - info.mtimeMs < 30_000
      ) {
        return false;
      }
      const current = await stat(lockPath);
      if (current.dev !== info.dev || current.ino !== info.ino) {
        return false;
      }
      await unlink(lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

async function readLock(lockPath: string): Promise<LockData> {
  const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockData>;
  if (
    !Number.isInteger(value.pid) ||
    typeof value.hostname !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.token !== "string"
  ) {
    throw new Error("Memory lock is invalid.");
  }
  return value as LockData;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return hasCode(error, "EPERM");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
