import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import {
  stateDirectoryLabel,
  workspaceStateRoot,
} from "../runtime/productPaths.js";
import { setTimeout as delay } from "node:timers/promises";
import { sameFileIdentity } from "../runtime/fileIdentity.js";
import { acquireFileLock } from "../runtime/fileLock.js";
import { SessionStore } from "./session.js";
import type {
  SessionEvent,
  SessionEventInput,
  SessionStatus,
} from "../protocol.js";
export type { SessionStatus } from "../protocol.js";

export interface SessionMetadata {
  id: string;
  title?: string;
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
}

export interface CreateSessionOptions {
  parentSessionId?: string;
  title?: string;
}

export interface ManagedSession {
  id: string;
  directoryPath: string;
  sessionPath: string;
  todoPath: string;
  metadataPath: string;
  checkpointPath: string;
  readMetadata(): Promise<SessionMetadata>;
  updateTitle(title: string): Promise<SessionMetadata>;
  updateStatus(status: SessionStatus): Promise<SessionMetadata>;
  updateLastSequence(sequence: number): Promise<SessionMetadata>;
  release(): Promise<void>;
}

interface SessionFiles {
  id: string;
  directoryPath: string;
  sessionPath: string;
  todoPath: string;
  metadataPath: string;
  checkpointPath: string;
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
  private readonly stateDir: string;
  private readonly stateLabel: string;
  private readonly sessionsDir: string;
  private readonly currentFile: string;
  private readonly layoutMarker: string;
  private readonly activeSessions = new Map<string, ManagedSession>();
  private storageReady?: Promise<void>;

  constructor(workspaceRoot: string, options: SessionManagerOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.model = options.model ?? "unknown";
    this.stateDir = workspaceStateRoot(this.workspaceRoot);
    this.stateLabel = stateDirectoryLabel(this.stateDir);
    this.sessionsDir = path.join(this.stateDir, "sessions");
    this.currentFile = path.join(this.sessionsDir, "current");
    this.layoutMarker = path.join(this.sessionsDir, ".layout-v2");
  }

  async start(resume?: string): Promise<ManagedSession> {
    if (resume) {
      return this.resume(resume);
    }

    await this.ensureStorageDirectories();
    await this.migrateLegacyIfPresent();
    return this.create();
  }

  async create(options: CreateSessionOptions = {}): Promise<ManagedSession> {
    await this.ensureStorageDirectories();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = createSessionId();
      const session = this.describe(id);

      try {
        await mkdir(session.directoryPath, { mode: 0o700 });
      } catch (error: unknown) {
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      try {
        await writeFile(session.sessionPath, "", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error: unknown) {
        await removeSessionDirectory(session);
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
        await removeSessionDirectory(session);
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      try {
        await this.createMetadata(session, options);
      } catch (error: unknown) {
        await removeSessionDirectory(session);
        throw error;
      }

      let managed: ManagedSession | undefined;

      try {
        managed = await this.acquireLease(session);
        await this.setCurrent(id);
        return managed;
      } catch (error: unknown) {
        await managed?.release();
        await removeSessionDirectory(session);
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

  async fork(source: ManagedSession): Promise<ManagedSession> {
    await this.ensureStorageDirectories();
    const sourceId = validateRealSessionId(source.id);
    if (this.activeSessions.get(sourceId) !== source) {
      throw new Error(`Cannot fork an unmanaged session: ${sourceId}`);
    }

    const [events, todos] = await Promise.all([
      new SessionStore(source.sessionPath, sourceId).load(),
      readSafeFile(source.todoPath, `Todo file for session ${sourceId}`),
    ]);
    const child = await this.create({ parentSessionId: sourceId });

    try {
      await writeManagedTextAtomic(
        child.todoPath,
        todos,
        `Todo file for session ${child.id}`,
      );
      const childStore = new SessionStore(child.sessionPath, child.id);
      let lastSequence = 0;
      for (const event of events) {
        if (event.type === "session_rewind") {
          continue;
        }
        lastSequence = (
          await childStore.append(withoutSessionEnvelope(event))
        ).sequence;
      }
      lastSequence = (
        await childStore.append({
          type: "session_status_changed",
          status: "running",
        })
      ).sequence;
      await child.updateLastSequence(lastSequence);
      return child;
    } catch (error: unknown) {
      await child.release();
      await removeSessionDirectory(this.describe(child.id));
      await this.setCurrent(sourceId);
      throw error;
    }
  }

  async list(limit = 20): Promise<SessionMetadata[]> {
    await this.ensureStorageDirectories();
    const entries = await readdir(this.sessionsDir, { withFileTypes: true });
    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isValidSessionId(entry.name))
        .map((entry) => this.ensureMetadata(this.describe(entry.name))),
    );

    return summaries
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id))
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
      updatedAt:
        latestEvent?.timestamp && latestEvent.timestamp > metadata.updatedAt
          ? latestEvent.timestamp
          : metadata.updatedAt,
    };
  }

  private describe(id: string): SessionFiles {
    const safeId = validateRealSessionId(id);

    const directoryPath = path.join(this.sessionsDir, safeId);
    return {
      id: safeId,
      directoryPath,
      sessionPath: path.join(directoryPath, "events.jsonl"),
      todoPath: path.join(directoryPath, "todos.json"),
      metadataPath: path.join(directoryPath, "summary.json"),
      checkpointPath: path.join(directoryPath, "checkpoints.json"),
    };
  }

  private async createMetadata(
    session: SessionFiles,
    options: CreateSessionOptions = {},
  ): Promise<SessionMetadata> {
    const timestamp = new Date().toISOString();
    const metadata: SessionMetadata = {
      id: session.id,
      ...(options.title ? { title: normalizeSessionTitle(options.title) } : {}),
      workspaceRoot: this.workspaceRoot,
      model: this.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "running",
      lastSequence: 0,
      ...(options.parentSessionId
        ? { parentSessionId: validateRealSessionId(options.parentSessionId) }
        : {}),
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
    };
    await writeMetadataAtomic(session.metadataPath, metadata, replaceExisting);
    return metadata;
  }

  private async ensureStorageDirectories(): Promise<void> {
    this.storageReady ??= this.prepareStorage();
    await this.storageReady;
  }

  private async prepareStorage(): Promise<void> {
    await ensureDirectory(this.stateDir, this.stateLabel);
    await ensureDirectory(this.sessionsDir, `${this.stateLabel}/sessions`);
    const releaseMigrationLock = await acquireFileLock(this.layoutMarker, {
      lockPath: `${this.layoutMarker}.lock`,
      label: "session layout migration",
    });
    try {
      if (await hasLayoutMarker(this.layoutMarker)) {
        return;
      }
      await this.migrateFlatLayout();
      await writeFile(this.layoutMarker, "2\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await syncDirectory(this.sessionsDir);
    } finally {
      await releaseMigrationLock();
    }
  }

  private async migrateFlatLayout(): Promise<void> {
    const entries = await readdir(this.sessionsDir, { withFileTypes: true });
    const legacyTodosDir = path.join(this.stateDir, "todos");
    const legacyCheckpointsDir = path.join(this.stateDir, "checkpoints");
    const sessionIds = new Set<string>();

    for (const entry of entries) {
      if (
        entry.isSymbolicLink() &&
        entry.name.endsWith(".jsonl")
      ) {
        throw new Error(
          `Refusing to migrate symbolic link at ${this.stateLabel}/sessions/${entry.name}.`,
        );
      }
      if (entry.isDirectory() && isValidSessionId(entry.name)) {
        sessionIds.add(entry.name);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name !== "latest.jsonl"
      ) {
        const id = entry.name.slice(0, -".jsonl".length);
        if (isValidSessionId(id)) {
          sessionIds.add(id);
        }
      }
    }

    for (const id of sessionIds) {
      const session = this.describe(id);
      await ensureDirectory(
        session.directoryPath,
        `${this.stateLabel}/sessions/${id}`,
      );
      await moveLegacyFile(
        path.join(this.sessionsDir, `${id}.jsonl`),
        session.sessionPath,
        `Legacy event log for session ${id}`,
        true,
      );
      await assertRegularFile(session.sessionPath, `Session ${id}`);
      await moveLegacyFile(
        path.join(this.sessionsDir, `${id}.meta.json`),
        session.metadataPath,
        `Legacy metadata for session ${id}`,
        true,
      );
      await moveLegacyFile(
        path.join(legacyTodosDir, `${id}.json`),
        session.todoPath,
        `Legacy todo file for session ${id}`,
        true,
      );
      await moveLegacyFile(
        path.join(legacyCheckpointsDir, `${id}.json`),
        session.checkpointPath,
        `Legacy checkpoint file for session ${id}`,
        true,
      );
      await ensureRegularFile(
        session.todoPath,
        "[]\n",
        `Todo file for session ${id}`,
      );
      await this.ensureMetadata(session);
    }

    await Promise.all([
      removeDirectoryIfEmpty(legacyTodosDir),
      removeDirectoryIfEmpty(legacyCheckpointsDir),
    ]);
  }

  private async setCurrent(id: string): Promise<void> {
    const safeId = validateRealSessionId(id);
    await ensureDirectory(this.stateDir, this.stateLabel);
    await ensureDirectory(this.sessionsDir, `${this.stateLabel}/sessions`);
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
    const legacyTodoPath = path.join(this.stateDir, "todos", "latest.json");
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
        await mkdir(session.directoryPath, { mode: 0o700 });
      } catch (error: unknown) {
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      try {
        await writeFile(session.sessionPath, sessionContents, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error: unknown) {
        await removeSessionDirectory(session);
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
        await removeSessionDirectory(session);
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      await removeIfExists(legacySessionPath);
      await removeIfExists(legacyTodoPath);
      await removeDirectoryIfEmpty(path.dirname(legacyTodoPath));
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

    await ensureDirectory(
      session.directoryPath,
      `${this.stateLabel}/sessions/${session.id}`,
    );
    const lockPath = path.join(session.directoryPath, "lease.lock");

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
        updateTitle: async (title) => {
          const normalized = normalizeSessionTitle(title);
          return updateMetadata((current) => ({
            ...current,
            title: normalized,
            updatedAt: new Date().toISOString(),
          }));
        },
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

async function hasLayoutMarker(markerPath: string): Promise<boolean> {
  try {
    const version = (await readSafeFile(markerPath, "Session layout marker")).trim();
    if (version !== "2") {
      throw new Error(`Unsupported session layout version: ${version || "empty"}.`);
    }
    return true;
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function withoutSessionEnvelope(event: SessionEvent): SessionEventInput {
  const input = { ...event } as Record<string, unknown>;
  delete input.eventId;
  delete input.sequence;
  delete input.sessionId;
  delete input.timestamp;
  delete input.ts;
  return input as SessionEventInput;
}

async function writeManagedTextAtomic(
  filePath: string,
  contents: string,
  label: string,
): Promise<void> {
  await assertRegularFile(filePath, label);
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const temporary = await open(temporaryPath, "wx", 0o600);
  try {
    await temporary.writeFile(contents, "utf8");
    await temporary.sync();
    await temporary.close();
    await assertRegularFile(filePath, label);
    await renameWithRetry(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error: unknown) {
    await temporary.close().catch(() => undefined);
    await removeIfExists(temporaryPath);
    throw error;
  }
}

async function moveLegacyFile(
  sourcePath: string,
  destinationPath: string,
  label: string,
  optional = false,
): Promise<void> {
  try {
    await assertRegularFile(sourcePath, label);
  } catch (error: unknown) {
    if (optional && hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  try {
    await lstat(destinationPath);
    throw new Error(
      `Refusing ambiguous session migration: both ${label} and its destination exist.`,
    );
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  await renameWithRetry(sourcePath, destinationPath);
}

async function removeDirectoryIfEmpty(directoryPath: string): Promise<void> {
  try {
    await rmdir(directoryPath);
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY")) {
      throw error;
    }
  }
}

async function removeSessionDirectory(session: SessionFiles): Promise<void> {
  await Promise.all([
    removeIfExists(session.sessionPath),
    removeIfExists(session.todoPath),
    removeIfExists(session.metadataPath),
    removeIfExists(session.checkpointPath),
    removeIfExists(path.join(session.directoryPath, "lease.lock")),
  ]);
  await removeDirectoryIfEmpty(session.directoryPath);
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
    (metadata.title === undefined ||
      isNormalizedSessionTitle(metadata.title)) &&
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

function isNormalizedSessionTitle(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return value === normalizeSessionTitle(value);
  } catch {
    return false;
  }
}

function normalizeSessionTitle(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Session title must be a string.");
  }
  if ([...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      codePoint === 127
    );
  })) {
    throw new Error("Session title cannot contain control characters.");
  }

  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    throw new Error("Session title cannot be empty.");
  }
  if ([...normalized].length > 80) {
    throw new Error("Session title cannot exceed 80 characters.");
  }
  return normalized;
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
  return sameFileIdentity(left, right);
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
