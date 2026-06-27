import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionStore } from "./session.js";
import type { SessionEvent, SessionStatus } from "./types.js";
export type { SessionStatus } from "./types.js";

export interface SessionMetadata {
  id: string;
  workspaceRoot: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  lastSequence: number;
  parentSessionId?: string;
}

export interface SessionManagerOptions {
  model?: string;
  parentSessionId?: string;
}

export interface ManagedSession {
  id: string;
  sessionPath: string;
  todoPath: string;
  metadataPath: string;
  readMetadata(): Promise<SessionMetadata>;
  updateStatus(status: SessionStatus): Promise<SessionMetadata>;
  updateLastSequence(sequence: number): Promise<SessionMetadata>;
  release(): Promise<void>;
}

interface SessionFiles {
  id: string;
  sessionPath: string;
  todoPath: string;
  metadataPath: string;
}

interface SessionLock {
  pid: number;
  hostname: string;
  createdAt: string;
  token: string;
}

export class SessionManager {
  private readonly workspaceRoot: string;
  private readonly model: string;
  private readonly parentSessionId?: string;
  private readonly harnessDir: string;
  private readonly sessionsDir: string;
  private readonly todosDir: string;
  private readonly locksDir: string;
  private readonly currentFile: string;
  private readonly activeSessions = new Map<string, ManagedSession>();

  constructor(workspaceRoot: string, options: SessionManagerOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.model = options.model ?? "unknown";
    this.parentSessionId = options.parentSessionId;
    this.harnessDir = path.join(this.workspaceRoot, ".harness");
    this.sessionsDir = path.join(this.harnessDir, "sessions");
    this.todosDir = path.join(this.harnessDir, "todos");
    this.locksDir = path.join(this.sessionsDir, ".locks");
    this.currentFile = path.join(this.sessionsDir, "current");
  }

  async start(resume?: string): Promise<ManagedSession> {
    if (resume) {
      return this.resume(resume);
    }

    await this.ensureStorageDirectories();
    await this.migrateLegacyIfPresent();
    return this.create();
  }

  async create(): Promise<ManagedSession> {
    await this.ensureStorageDirectories();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = createSessionId();
      const session = this.describe(id);

      try {
        await writeFile(session.sessionPath, "", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error: unknown) {
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      try {
        await writeFile(session.todoPath, "[]\n", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error: unknown) {
        await removeIfExists(session.sessionPath);
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      try {
        await this.createMetadata(session);
      } catch (error: unknown) {
        await Promise.all([
          removeIfExists(session.sessionPath),
          removeIfExists(session.todoPath),
        ]);
        throw error;
      }

      let managed: ManagedSession | undefined;

      try {
        managed = await this.acquireLease(session);
        await this.setCurrent(id);
        return managed;
      } catch (error: unknown) {
        await managed?.release();
        await Promise.all([
          removeIfExists(session.sessionPath),
          removeIfExists(session.todoPath),
          removeIfExists(session.metadataPath),
        ]);
        throw error;
      }
    }

    throw new Error("Unable to allocate a unique session id.");
  }

  async resume(requestedId: string): Promise<ManagedSession> {
    await this.ensureStorageDirectories();
    const id =
      requestedId === "latest"
        ? await this.readCurrentOrLegacy()
        : validateRealSessionId(requestedId);
    const session = this.describe(id);

    try {
      await assertRegularFile(session.sessionPath, `Session ${id}`);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        throw new Error(`Session not found: ${id}`);
      }
      throw error;
    }
    await ensureRegularFile(session.todoPath, "[]\n", `Todo file for session ${id}`);
    const managed = await this.acquireLease(session);

    try {
      await this.setCurrent(id);
      return managed;
    } catch (error: unknown) {
      await managed.release();
      throw error;
    }
  }

  async list(limit = 20): Promise<string[]> {
    await this.ensureStorageDirectories();
    const entries = await readdir(this.sessionsDir, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.slice(0, -".jsonl".length))
      .filter((id) => id !== "latest" && isValidSessionId(id))
      .sort()
      .reverse()
      .slice(0, Math.max(1, limit));
  }

  async inspect(requestedId: string): Promise<SessionMetadata> {
    await this.ensureStorageDirectories();
    const id =
      requestedId === "latest"
        ? await this.readCurrentOrLegacy()
        : validateRealSessionId(requestedId);
    const session = this.describe(id);

    try {
      await assertRegularFile(session.sessionPath, `Session ${id}`);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        throw new Error(`Session not found: ${id}`);
      }
      throw error;
    }

    const [metadata, events] = await Promise.all([
      this.ensureMetadata(session),
      new SessionStore(session.sessionPath, session.id).load(),
    ]);
    const latestLifecycle = [...events].reverse().find((event) =>
      [
        "session_status_changed",
        "session_cancelled",
        "session_failed",
        "assistant_final",
        "approval_requested",
        "approval_resolved",
      ].includes(event.type),
    );
    const latestEvent = events.at(-1);

    return {
      ...metadata,
      status: lifecycleStatus(latestLifecycle) ?? metadata.status,
      lastSequence: Math.max(
        metadata.lastSequence,
        latestEvent?.sequence ?? 0,
      ),
      updatedAt: latestEvent?.timestamp ?? metadata.updatedAt,
    };
  }

  private describe(id: string): SessionFiles {
    const safeId = validateRealSessionId(id);

    return {
      id: safeId,
      sessionPath: path.join(this.sessionsDir, `${safeId}.jsonl`),
      todoPath: path.join(this.todosDir, `${safeId}.json`),
      metadataPath: path.join(this.sessionsDir, `${safeId}.meta.json`),
    };
  }

  private async createMetadata(session: SessionFiles): Promise<SessionMetadata> {
    const timestamp = new Date().toISOString();
    const metadata: SessionMetadata = {
      id: session.id,
      workspaceRoot: this.workspaceRoot,
      model: this.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "running",
      lastSequence: 0,
      ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
    };
    await writeMetadataAtomic(session.metadataPath, metadata, false);
    return metadata;
  }

  private async ensureMetadata(session: SessionFiles): Promise<SessionMetadata> {
    let replaceExisting = false;
    try {
      return await readMetadata(session.metadataPath, session.id);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        replaceExisting = false;
      } else if (isRecoverableMetadataError(error, session.id)) {
        replaceExisting = true;
      } else {
        throw error;
      }
    }

    const events = await new SessionStore(session.sessionPath, session.id).load();
    const info = await lstat(session.sessionPath);
    const createdAt = info.birthtimeMs > 0
      ? info.birthtime.toISOString()
      : info.mtime.toISOString();
    const latestEvent = events.at(-1);
    const updatedAt = latestEvent?.timestamp ?? new Date().toISOString();
    const metadata: SessionMetadata = {
      id: session.id,
      workspaceRoot: this.workspaceRoot,
      model: this.model,
      createdAt,
      updatedAt,
      status:
        lifecycleStatus(
          [...events].reverse().find((event) =>
            [
              "session_status_changed",
              "session_cancelled",
              "session_failed",
              "assistant_final",
              "approval_requested",
              "approval_resolved",
            ].includes(event.type),
          ),
        ) ?? "running",
      lastSequence: latestEvent?.sequence ?? 0,
      ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
    };
    await writeMetadataAtomic(session.metadataPath, metadata, replaceExisting);
    return metadata;
  }

  private async ensureStorageDirectories(): Promise<void> {
    await ensureDirectory(this.harnessDir, ".harness");
    await ensureDirectory(this.sessionsDir, ".harness/sessions");
    await ensureDirectory(this.todosDir, ".harness/todos");
    await ensureDirectory(this.locksDir, ".harness/sessions/.locks");
  }

  private async setCurrent(id: string): Promise<void> {
    const safeId = validateRealSessionId(id);
    await ensureDirectory(this.harnessDir, ".harness");
    await ensureDirectory(this.sessionsDir, ".harness/sessions");
    await assertRegularFile(this.currentFile, "Current session pointer", true);

    const temporaryPath = path.join(
      this.sessionsDir,
      `.current.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const temporary = await open(temporaryPath, "wx", 0o600);

    try {
      await temporary.writeFile(`${safeId}\n`, "utf8");
      await temporary.sync();
      await temporary.close();
      await assertRegularFile(this.currentFile, "Current session pointer", true);
      await renameWithRetry(temporaryPath, this.currentFile);
    } catch (error: unknown) {
      await temporary.close().catch(() => undefined);
      await removeIfExists(temporaryPath);
      throw error;
    }
  }

  private async readCurrentOrLegacy(): Promise<string> {
    try {
      const value = (await readSafeFile(this.currentFile, "Current session pointer")).trim();

      if (!value) {
        throw new Error("Current session pointer is empty.");
      }
      if (value === "latest") {
        return this.migrateLegacySession();
      }

      try {
        return validateRealSessionId(value);
      } catch {
        throw new Error(`Current session pointer is invalid: ${value}`);
      }
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }

    return this.migrateLegacySession();
  }

  private async migrateLegacySession(): Promise<string> {
    const legacySessionPath = path.join(this.sessionsDir, "latest.jsonl");
    const legacyTodoPath = path.join(this.todosDir, "latest.json");
    let sessionContents: string;

    try {
      sessionContents = await readSafeFile(legacySessionPath, "Legacy latest session");
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        throw new Error("No previous session is available.");
      }
      throw error;
    }

    let todoContents = "[]\n";
    try {
      todoContents = await readSafeFile(legacyTodoPath, "Legacy latest todo file");
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = createSessionId();
      const session = this.describe(id);

      try {
        await writeFile(session.sessionPath, sessionContents, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error: unknown) {
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      try {
        await writeFile(session.todoPath, todoContents, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await this.ensureMetadata(session);
        await this.setCurrent(id);
      } catch (error: unknown) {
        await Promise.all([
          removeIfExists(session.sessionPath),
          removeIfExists(session.todoPath),
          removeIfExists(session.metadataPath),
        ]);
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      await removeIfExists(legacySessionPath);
      await removeIfExists(legacyTodoPath);
      return id;
    }

    throw new Error("Unable to allocate a unique session id for legacy migration.");
  }

  private async migrateLegacyIfPresent(): Promise<void> {
    const legacySessionPath = path.join(this.sessionsDir, "latest.jsonl");

    try {
      await assertRegularFile(legacySessionPath, "Legacy latest session");
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    await this.migrateLegacySession();
  }

  private async acquireLease(session: SessionFiles): Promise<ManagedSession> {
    const active = this.activeSessions.get(session.id);

    if (active) {
      return active;
    }

    await ensureDirectory(this.locksDir, ".harness/sessions/.locks");
    const lockPath = path.join(this.locksDir, `${session.id}.lock`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lock: SessionLock = {
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
      } catch (error: unknown) {
        if (
          hasCode(error, "EEXIST") &&
          attempt === 0 &&
          (await removeStaleLock(lockPath))
        ) {
          continue;
        }

        if (hasCode(error, "EEXIST")) {
          const existing = await readLock(lockPath).catch(() => null);
          const detail = existing
            ? ` by pid ${existing.pid} on ${existing.hostname} since ${existing.createdAt}`
            : "";
          throw new Error(`Session is already active${detail}: ${session.id}`);
        }

        throw error;
      }

      let released = false;
      let metadataQueue: Promise<SessionMetadata> = Promise.resolve(
        await this.ensureMetadata(session),
      );
      const updateMetadata = (
        update: (current: SessionMetadata) => SessionMetadata,
      ): Promise<SessionMetadata> => {
        const operation = metadataQueue
          .catch(() => readMetadata(session.metadataPath, session.id))
          .then(async (current) => {
            const next = update(current);
            await writeMetadataAtomic(session.metadataPath, next, true);
            return next;
          });
        metadataQueue = operation;
        return operation;
      };
      const managed: ManagedSession = {
        ...session,
        readMetadata: () => metadataQueue.catch(() =>
          readMetadata(session.metadataPath, session.id),
        ),
        updateStatus: (status) =>
          updateMetadata((current) => ({
            ...current,
            status,
            updatedAt: new Date().toISOString(),
          })),
        updateLastSequence: (sequence) => {
          if (!Number.isSafeInteger(sequence) || sequence < 0) {
            return Promise.reject(new Error(`Invalid session sequence: ${sequence}`));
          }
          return updateMetadata((current) => ({
            ...current,
            lastSequence: Math.max(current.lastSequence, sequence),
            updatedAt: new Date().toISOString(),
          }));
        },
        release: async () => {
          if (released) {
            return;
          }

          released = true;
          this.activeSessions.delete(session.id);
          await removeOwnedLock(lockPath, lock.token);
        },
      };
      this.activeSessions.set(session.id, managed);
      return managed;
    }

    throw new Error(`Unable to acquire session lease: ${session.id}`);
  }
}

async function ensureDirectory(directoryPath: string, label: string): Promise<void> {
  try {
    await mkdir(directoryPath);
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }

  const info = await lstat(directoryPath);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to use symbolic link at ${label}.`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Expected ${label} to be a directory.`);
  }
}

async function ensureRegularFile(
  filePath: string,
  initialContents: string,
  label: string,
): Promise<void> {
  try {
    await writeFile(filePath, initialContents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return;
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }

  await assertRegularFile(filePath, label);
}

async function assertRegularFile(
  filePath: string,
  label: string,
  allowMissing = false,
): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(filePath);
  } catch (error: unknown) {
    if (allowMissing && hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to use symbolic link at ${label}.`);
  }
  if (!info.isFile()) {
    throw new Error(`${label} is not a regular file.`);
  }
}

async function readSafeFile(filePath: string, label: string): Promise<string> {
  await assertRegularFile(filePath, label);
  const handle = await open(filePath, "r");

  try {
    const [pathInfo, fileInfo] = await Promise.all([lstat(filePath), handle.stat()]);
    if (
      pathInfo.isSymbolicLink() ||
      !pathInfo.isFile() ||
      !sameFile(pathInfo, fileInfo)
    ) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readMetadata(
  metadataPath: string,
  expectedId: string,
): Promise<SessionMetadata> {
  const parsed = JSON.parse(
    await readSafeFile(metadataPath, `Metadata for session ${expectedId}`),
  ) as unknown;

  if (!isSessionMetadata(parsed) || parsed.id !== expectedId) {
    throw new Error(`Metadata for session ${expectedId} is invalid.`);
  }
  return parsed;
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const metadata = value as Partial<SessionMetadata>;
  return (
    typeof metadata.id === "string" &&
    typeof metadata.workspaceRoot === "string" &&
    typeof metadata.model === "string" &&
    typeof metadata.createdAt === "string" &&
    typeof metadata.updatedAt === "string" &&
    isSessionStatus(metadata.status) &&
    typeof metadata.lastSequence === "number" &&
    Number.isSafeInteger(metadata.lastSequence) &&
    metadata.lastSequence >= 0 &&
    (metadata.parentSessionId === undefined ||
      typeof metadata.parentSessionId === "string")
  );
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === "running" ||
    value === "waiting_for_approval" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "failed"
  );
}

function lifecycleStatus(event: SessionEvent | undefined): SessionStatus | undefined {
  if (event?.type === "session_status_changed") {
    return event.status;
  }
  if (event?.type === "session_cancelled") {
    return "cancelled";
  }
  if (event?.type === "session_failed") {
    return "failed";
  }
  if (event?.type === "assistant_final") {
    return "completed";
  }
  if (event?.type === "approval_requested") {
    return "waiting_for_approval";
  }
  if (event?.type === "approval_resolved") {
    return "running";
  }
  return undefined;
}

function isRecoverableMetadataError(
  error: unknown,
  sessionId: string,
): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      error.message === `Metadata for session ${sessionId} is invalid.`)
  );
}

async function writeMetadataAtomic(
  metadataPath: string,
  metadata: SessionMetadata,
  allowExisting: boolean,
): Promise<void> {
  await assertRegularFile(metadataPath, `Metadata for session ${metadata.id}`, true);
  if (!allowExisting) {
    try {
      await lstat(metadataPath);
      const error = new Error(`Metadata already exists for session ${metadata.id}.`);
      (error as NodeJS.ErrnoException).code = "EEXIST";
      throw error;
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  const temporaryPath = path.join(
    path.dirname(metadataPath),
    `.${path.basename(metadataPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const temporary = await open(temporaryPath, "wx", 0o600);

  try {
    await temporary.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await temporary.sync();
    await temporary.close();
    await assertRegularFile(
      metadataPath,
      `Metadata for session ${metadata.id}`,
      true,
    );
    await renameWithRetry(temporaryPath, metadataPath);
    await syncDirectory(path.dirname(metadataPath));
  } catch (error: unknown) {
    await temporary.close().catch(() => undefined);
    await removeIfExists(temporaryPath);
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directory;
  try {
    directory = await open(directoryPath, "r");
    await directory.sync();
  } catch (error: unknown) {
    if (
      !hasCode(error, "EINVAL") &&
      !hasCode(error, "EPERM") &&
      !hasCode(error, "EACCES") &&
      !hasCode(error, "EBADF") &&
      !hasCode(error, "EISDIR") &&
      !hasCode(error, "ENOTSUP")
    ) {
      throw error;
    }
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function renameWithRetry(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error: unknown) {
      if (
        attempt === 3 ||
        (!hasCode(error, "EPERM") &&
          !hasCode(error, "EACCES") &&
          !hasCode(error, "EBUSY"))
      ) {
        throw error;
      }
      await delay(25 * 2 ** attempt);
    }
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function readLock(lockPath: string): Promise<SessionLock> {
  const parsed = JSON.parse(await readSafeFile(lockPath, "Session lock")) as unknown;

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as SessionLock).pid !== "number" ||
    typeof (parsed as SessionLock).hostname !== "string" ||
    typeof (parsed as SessionLock).createdAt !== "string" ||
    typeof (parsed as SessionLock).token !== "string"
  ) {
    throw new Error("Session lock is invalid.");
  }

  return parsed as SessionLock;
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
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
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
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

function createSessionId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "-")
    .replace("Z", "");
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

function validateRealSessionId(value: string): string {
  if (value === "latest" || !isValidSessionId(value)) {
    throw new Error(`Invalid session id: ${value}`);
  }
  return value;
}

function isValidSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
