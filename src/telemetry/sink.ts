import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { acquireFileLock } from "../runtime/fileLock.js";
import {
  isCanonicalTelemetryEvent,
  sanitizeTelemetryEvent,
} from "./sanitize.js";
import type {
  JsonlTelemetrySinkOptions,
  TelemetryEvent,
  TelemetrySink,
  TelemetrySinkFailure,
} from "./types.js";

const FILE_NAME = "telemetry.jsonl";
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_BYTES = 1024 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const appendQueues = new Map<string, Promise<unknown>>();

interface StoredTelemetryEnvelope {
  schemaVersion: 1;
  eventId: string;
  timestamp: string;
  event: TelemetryEvent;
}

export class JsonlTelemetrySink implements TelemetrySink {
  readonly filePath: string;
  private readonly maxBytes: number;
  private readonly lockTimeoutMs: number;
  private readonly onError?: (failure: TelemetrySinkFailure) => void;
  private closed = false;

  constructor(
    directoryPath: string,
    options: JsonlTelemetrySinkOptions = {},
  ) {
    this.filePath = path.join(path.resolve(directoryPath), FILE_NAME);
    this.maxBytes = boundedInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      MAX_EVENT_BYTES,
      MAX_CONFIGURED_BYTES,
    );
    this.lockTimeoutMs = boundedInteger(
      options.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      1,
      60_000,
    );
    this.onError = options.onError;
  }

  async emit(event: TelemetryEvent): Promise<void> {
    if (this.closed) {
      this.report("append", new Error("Telemetry sink is closed."));
      return;
    }

    let sanitized: TelemetryEvent;
    try {
      sanitized = sanitizeTelemetryEvent(event);
    } catch (error: unknown) {
      this.report("validate", error);
      return;
    }

    const key = path.resolve(this.filePath);
    try {
      await serializeOperation(key, () => this.append(sanitized));
    } catch (error: unknown) {
      this.report(classifyFailure(error), error);
    }
  }

  async flush(): Promise<void> {
    const pending = appendQueues.get(path.resolve(this.filePath));
    if (pending) {
      await pending.catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.flush();
    } catch (error: unknown) {
      this.report("close", error);
    }
  }

  private async append(event: TelemetryEvent): Promise<void> {
    await ensureSafeDirectory(path.dirname(this.filePath));

    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireFileLock(this.filePath, {
        timeoutMs: this.lockTimeoutMs,
        label: "telemetry",
      });
    } catch (error: unknown) {
      throw taggedError("lock", error);
    }

    let committed = false;
    try {
      const handle = await openTelemetryFile(this.filePath);
      try {
        const { validBytes, needsNewline } = await readAndValidate(
          handle,
          this.maxBytes,
          true,
        );
        const envelope: StoredTelemetryEnvelope = {
          schemaVersion: 1,
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
          event,
        };
        const line = `${JSON.stringify(envelope)}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (lineBytes > MAX_EVENT_BYTES) {
          throw taggedError(
            "append",
            new Error("Telemetry event exceeds the 16 KiB event limit."),
          );
        }
        const appendBytes = lineBytes + (needsNewline ? 1 : 0);
        if (validBytes + appendBytes > this.maxBytes) {
          throw taggedError(
            "append",
            new Error("Telemetry log has reached its configured size limit."),
          );
        }

        const fileInfo = await handle.stat();
        if (fileInfo.size !== validBytes) {
          await handle.truncate(validBytes);
        }
        if (needsNewline) {
          await handle.writeFile("\n", "utf8");
        }
        await handle.writeFile(line, "utf8");
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
          throw taggedError("lock", error);
        }
        this.report("lock", error);
      }
    }
  }

  private report(
    operation: TelemetrySinkFailure["operation"],
    error: unknown,
  ): void {
    try {
      this.onError?.({ operation, error });
    } catch {
      // Telemetry diagnostics must never affect the caller.
    }
  }
}

export class NoopTelemetrySink implements TelemetrySink {
  async emit(_event: TelemetryEvent): Promise<void> {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export const noopTelemetrySink: TelemetrySink = Object.freeze(
  new NoopTelemetrySink(),
);

export function createTelemetrySink(
  directoryPath: string,
  options: JsonlTelemetrySinkOptions = {},
): TelemetrySink {
  try {
    return new JsonlTelemetrySink(directoryPath, options);
  } catch (error: unknown) {
    try {
      options.onError?.({ operation: "prepare", error });
    } catch {
      // Sink creation remains fail-open even when its error hook fails.
    }
    return noopTelemetrySink;
  }
}

async function serializeOperation<T>(
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

async function ensureSafeDirectory(directoryPath: string): Promise<void> {
  try {
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const info = await lstat(directoryPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Telemetry directory must be a real directory.");
    }
    if (process.platform !== "win32") {
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && info.uid !== currentUid) {
        throw new Error(
          "Telemetry directory must be owned by the current user.",
        );
      }
      await chmod(directoryPath, 0o700);
    }
  } catch (error: unknown) {
    throw taggedError("prepare", error);
  }
}

async function openTelemetryFile(filePath: string): Promise<FileHandle> {
  try {
    const flags =
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_RDWR |
      (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(filePath, flags, 0o600);
    try {
      const [pathInfo, handleInfo] = await Promise.all([
        lstat(filePath),
        handle.stat(),
      ]);
      if (
        pathInfo.isSymbolicLink() ||
        !pathInfo.isFile() ||
        pathInfo.dev !== handleInfo.dev ||
        pathInfo.ino !== handleInfo.ino ||
        handleInfo.nlink !== 1
      ) {
        throw new Error(
          "Refusing a symbolic link, hard link, or replaced telemetry log.",
        );
      }
      await chmod(filePath, 0o600);
      return handle;
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
  } catch (error: unknown) {
    throw taggedError("prepare", error);
  }
}

async function readAndValidate(
  handle: FileHandle,
  maxBytes: number,
  recoverTail: boolean,
): Promise<{ validBytes: number; needsNewline: boolean }> {
  try {
    const fileInfo = await handle.stat();
    if (fileInfo.size > maxBytes) {
      throw new Error("Telemetry log exceeds its configured size limit.");
    }
    const buffer = Buffer.alloc(fileInfo.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== buffer.length) {
      throw new Error("Telemetry log changed while being read.");
    }

    let offset = 0;
    let validBytes = 0;
    let needsNewline = false;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(0x0a, offset);
      const hasNewline = newline !== -1;
      const end = hasNewline ? newline : buffer.length;
      const line = buffer.subarray(offset, end);
      if (line.length === 0) {
        validBytes = hasNewline ? end + 1 : end;
        offset = end + 1;
        continue;
      }

      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        validateEnvelope(JSON.parse(text) as unknown);
        validBytes = end + (hasNewline ? 1 : 0);
        needsNewline = !hasNewline;
      } catch (error: unknown) {
        const isLastRecord = !hasNewline || end + 1 === buffer.length;
        if (recoverTail && isLastRecord) {
          return { validBytes, needsNewline: false };
        }
        throw new Error(
          `Telemetry log contains an invalid record: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      offset = end + 1;
    }
    return { validBytes, needsNewline };
  } catch (error: unknown) {
    throw taggedError("read", error);
  }
}

function validateEnvelope(value: unknown): StoredTelemetryEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Envelope must be an object.");
  }
  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope);
  if (
    keys.length !== 4 ||
    !["schemaVersion", "eventId", "timestamp", "event"].every((key) =>
      Object.hasOwn(envelope, key),
    )
  ) {
    throw new Error("Envelope fields are invalid.");
  }
  if (envelope.schemaVersion !== 1) {
    throw new Error("Envelope schema version is invalid.");
  }
  if (
    typeof envelope.eventId !== "string" ||
    envelope.eventId.length > 200 ||
    !/^[A-Za-z0-9-]+$/.test(envelope.eventId)
  ) {
    throw new Error("Envelope event ID is invalid.");
  }
  if (
    typeof envelope.timestamp !== "string" ||
    new Date(envelope.timestamp).toISOString() !== envelope.timestamp
  ) {
    throw new Error("Envelope timestamp is invalid.");
  }
  if (!isCanonicalTelemetryEvent(envelope.event)) {
    throw new Error("Envelope event is not canonical.");
  }
  return envelope as unknown as StoredTelemetryEnvelope;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Value must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function taggedError(
  operation: TelemetrySinkFailure["operation"],
  cause: unknown,
): Error {
  const error = new Error(
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );
  Object.assign(error, { telemetryOperation: operation });
  return error;
}

function classifyFailure(
  error: unknown,
): TelemetrySinkFailure["operation"] {
  if (
    error instanceof Error &&
    "telemetryOperation" in error &&
    typeof error.telemetryOperation === "string" &&
    ["prepare", "lock", "read", "append"].includes(error.telemetryOperation)
  ) {
    return error.telemetryOperation as TelemetrySinkFailure["operation"];
  }
  return "append";
}
