import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  isCancellationError,
  throwIfCancelled,
} from "../agent/cancellation.js";
import type { Workspace } from "./workspace.js";

export const DEFAULT_MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

export type FileOperationErrorCode =
  | "not_found"
  | "conflict"
  | "output_limit"
  | "invalid_encoding"
  | "binary_file"
  | "permission_denied"
  | "internal_error";

export class FileOperationError extends Error {
  constructor(
    readonly code: FileOperationErrorCode,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(messageForCode(code));
    this.name = "FileOperationError";
  }
}

export type TextFileLineEnding = "none" | "lf" | "crlf" | "mixed";

export interface TextFileSnapshot {
  workspaceRoot: string;
  logicalPath: string;
  absolutePath: string;
  text: string;
  hash: string;
  size: number;
  mode: number;
  bom: boolean;
  lineEnding: TextFileLineEnding;
  dev: number;
  ino: number;
}

interface ReadOptions {
  maxBytes?: number;
  forEdit?: boolean;
  allowOutside?: boolean;
  outsideRoot?: string;
  signal?: AbortSignal;
}

interface ReplaceOptions {
  signal?: AbortSignal;
}

interface CreateOptions {
  maxBytes?: number;
  allowOutside?: boolean;
  outsideRoot?: string;
  signal?: AbortSignal;
  mode?: number;
}

interface Identity {
  dev: number;
  ino: number;
}

export async function readTextFileSnapshot(
  workspace: Workspace,
  userPath: string,
  options: ReadOptions = {},
): Promise<TextFileSnapshot> {
  try {
    throwIfCancelled(options.signal);
    const maxBytes = normalizeMaxBytes(options.maxBytes);
    const accessOptions = {
      allowOutside: options.allowOutside === true,
      outsideRoot: options.outsideRoot,
    };
    const absolutePath = workspace.resolve(userPath, accessOptions);
    const accessRoot = traversalRoot(
      workspace.root,
      absolutePath,
      path.dirname(absolutePath),
    );
    const initialLinkInfo = await lstat(absolutePath);

    if (options.forEdit) {
      await assertNoSymlinkComponents(accessRoot, absolutePath, userPath);
    }

    await workspace.assertRealPathWithin(absolutePath, accessOptions);
    const initialRealPath = await realpath(absolutePath);
    const handle = await open(absolutePath, "r");

    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile()) {
        throw fileError("conflict", false, {
          path: userPath,
          reason: "not_a_regular_file",
        });
      }

      await verifyOpenedPath(
        absolutePath,
        initialRealPath,
        openedInfo,
        initialLinkInfo.isSymbolicLink(),
        options.forEdit === true,
      );
      await workspace.assertRealPathWithin(absolutePath, accessOptions);
      const bytes = await readBytes(handle, maxBytes, options.signal);
      const finalInfo = await handle.stat();
      await verifyOpenedPath(
        absolutePath,
        initialRealPath,
        finalInfo,
        initialLinkInfo.isSymbolicLink(),
        options.forEdit === true,
      );
      await workspace.assertRealPathWithin(absolutePath, accessOptions);

      if (
        !sameIdentity(openedInfo, finalInfo) ||
        openedInfo.size !== finalInfo.size ||
        bytes.length !== finalInfo.size
      ) {
        throw fileError("conflict", true, {
          path: userPath,
          reason: "file_changed_while_reading",
        });
      }

      const text = decodeText(bytes, userPath);
      return snapshotFromBytes(
        accessRoot,
        userPath,
        absolutePath,
        text,
        bytes,
        finalInfo.mode,
        finalInfo,
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw mapError(error, userPath, options.signal);
  }
}

export async function atomicReplaceTextFile(
  snapshot: TextFileSnapshot,
  newText: string,
  options: ReplaceOptions = {},
): Promise<TextFileSnapshot> {
  const bytes = encodeText(
    newText,
    DEFAULT_MAX_TEXT_FILE_BYTES,
    snapshot.logicalPath,
    snapshot.bom,
  );
  const directory = path.dirname(snapshot.absolutePath);
  const lockPath = path.join(
    directory,
    `.${path.basename(snapshot.absolutePath)}.text-file.lock`,
  );
  let lockHandle: FileHandle | undefined;
  let lockIdentity: Identity | undefined;
  let tempPath: string | undefined;
  let replacementIdentity: Identity | undefined;
  let published = false;

  try {
    throwIfCancelled(options.signal);
    await assertNoSymlinkComponents(
      snapshot.workspaceRoot,
      snapshot.absolutePath,
      snapshot.logicalPath,
    );
    lockHandle = await acquireEditLock(lockPath, snapshot.logicalPath);
    lockIdentity = await lockHandle.stat();

    await assertExpectedFile(snapshot, options.signal);
    throwIfCancelled(options.signal);

    const temp = await openRandomTemp(directory, path.basename(snapshot.absolutePath));
    tempPath = temp.path;
    try {
      await writeCompleteFile(temp.handle, bytes, options.signal);
      await temp.handle.chmod(snapshot.mode);
      await temp.handle.sync();
      replacementIdentity = await temp.handle.stat();
    } finally {
      await temp.handle.close();
    }

    await assertExpectedFile(snapshot, options.signal);
    await assertTemporaryIdentity(temp.path, replacementIdentity!);
    throwIfCancelled(options.signal);
    await renameWithRetry(temp.path, snapshot.absolutePath);
    published = true;
    tempPath = undefined;
    await syncDirectoryBestEffort(directory);

    const info = await stat(snapshot.absolutePath);
    return snapshotFromBytes(
      snapshot.workspaceRoot,
      snapshot.logicalPath,
      snapshot.absolutePath,
      newText,
      bytes,
      info.mode,
      info,
    );
  } catch (error) {
    if (published) {
      return snapshotFromBytes(
        snapshot.workspaceRoot,
        snapshot.logicalPath,
        snapshot.absolutePath,
        newText,
        bytes,
        snapshot.mode,
        replacementIdentity ?? snapshot,
      );
    }
    throw mapError(error, snapshot.logicalPath, options.signal);
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined);
    if (lockHandle) {
      await lockHandle.close().catch(() => undefined);
      await releaseEditLock(lockPath, lockIdentity).catch(() => undefined);
    }
  }
}

export async function atomicCreateTextFile(
  workspace: Workspace,
  userPath: string,
  text: string,
  options: CreateOptions = {},
): Promise<TextFileSnapshot> {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const bytes = encodeText(text, maxBytes, userPath);
  const accessOptions = {
    allowOutside: options.allowOutside === true,
    outsideRoot: options.outsideRoot,
  };
  const absolutePath = workspace.resolve(userPath, accessOptions);
  const directory = path.dirname(absolutePath);
  const accessRoot = traversalRoot(workspace.root, directory, directory);
  let tempPath: string | undefined;
  let tempInfo: Awaited<ReturnType<FileHandle["stat"]>> | undefined;
  let published = false;

  try {
    throwIfCancelled(options.signal);
    const directoryInfo = await lstat(directory);

    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw fileError("conflict", false, {
        path: userPath,
        reason: "unsafe_parent_directory",
      });
    }

    await workspace.assertRealPathWithin(directory, accessOptions);
    await assertNoSymlinkComponents(accessRoot, directory, userPath);
    const directoryRealPath = await realpath(directory);
    const directoryIdentity = await stat(directoryRealPath);
    throwIfCancelled(options.signal);

    const temp = await openRandomTemp(directory, path.basename(absolutePath));
    tempPath = temp.path;
    try {
      await writeCompleteFile(temp.handle, bytes, options.signal);
      const createMode =
        normalizeMode(options.mode ?? 0o666) & ~process.umask();
      await temp.handle.chmod(createMode);
      await temp.handle.sync();
      tempInfo = await temp.handle.stat();
    } finally {
      await temp.handle.close();
    }

    await assertTemporaryIdentity(temp.path, tempInfo!);
    await workspace.assertRealPathWithin(directory, accessOptions);
    if (
      (await realpath(directory)) !== directoryRealPath ||
      !sameIdentity(await stat(directoryRealPath), directoryIdentity)
    ) {
      throw fileError("conflict", true, {
        path: userPath,
        reason: "parent_directory_changed",
      });
    }
    throwIfCancelled(options.signal);
    await link(temp.path, absolutePath);
    published = true;
    await unlink(temp.path);
    tempPath = undefined;
    await syncDirectoryBestEffort(directory);

    return snapshotFromBytes(
      accessRoot,
      userPath,
      absolutePath,
      text,
      bytes,
      tempInfo!.mode,
      tempInfo!,
    );
  } catch (error) {
    if (published) {
      const info = await stat(absolutePath).catch(() => undefined);
      return snapshotFromBytes(
        accessRoot,
        userPath,
        absolutePath,
        text,
        bytes,
        info?.mode ?? normalizeMode(options.mode ?? 0o666),
        info ?? { dev: 0, ino: 0 },
      );
    }
    throw mapError(error, userPath, options.signal);
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined);
  }
}

async function assertExpectedFile(
  snapshot: TextFileSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  await assertNoSymlinkComponents(
    snapshot.workspaceRoot,
    snapshot.absolutePath,
    snapshot.logicalPath,
  );
  const linkInfo = await lstat(snapshot.absolutePath);
  if (linkInfo.isSymbolicLink() || !sameIdentity(linkInfo, snapshot)) {
    throw fileError("conflict", true, {
      path: snapshot.logicalPath,
      reason: "identity_changed",
    });
  }

  const handle = await open(snapshot.absolutePath, "r");
  try {
    const openedInfo = await handle.stat();
    if (!sameIdentity(openedInfo, snapshot)) {
      throw fileError("conflict", true, {
        path: snapshot.logicalPath,
        reason: "identity_changed",
      });
    }
    const bytes = await readBytes(handle, DEFAULT_MAX_TEXT_FILE_BYTES, signal);
    const finalInfo = await handle.stat();
    const finalLinkInfo = await lstat(snapshot.absolutePath);
    if (
      !sameIdentity(openedInfo, finalInfo) ||
      !sameIdentity(finalInfo, finalLinkInfo) ||
      bytes.length !== finalInfo.size ||
      sha256(bytes) !== snapshot.hash
    ) {
      throw fileError("conflict", true, {
        path: snapshot.logicalPath,
        reason: "content_changed",
      });
    }
  } finally {
    await handle.close();
  }
}

async function verifyOpenedPath(
  absolutePath: string,
  expectedRealPath: string,
  openedInfo: Identity,
  wasSymlink: boolean,
  forEdit: boolean,
): Promise<void> {
  const currentLinkInfo = await lstat(absolutePath);
  if (forEdit && currentLinkInfo.isSymbolicLink()) {
    throw fileError("conflict", true, { reason: "symlink_edit_denied" });
  }

  const currentRealPath = await realpath(absolutePath);
  const currentTargetInfo = wasSymlink
    ? await stat(currentRealPath)
    : currentLinkInfo;
  if (
    currentRealPath !== expectedRealPath ||
    currentLinkInfo.isSymbolicLink() !== wasSymlink ||
    !sameIdentity(currentTargetInfo, openedInfo)
  ) {
    throw fileError("conflict", true, { reason: "path_changed_during_open" });
  }
}

async function assertTemporaryIdentity(
  tempPath: string,
  expected: Identity,
): Promise<void> {
  const linkInfo = await lstat(tempPath);
  if (linkInfo.isSymbolicLink() || !sameIdentity(linkInfo, expected)) {
    throw fileError("conflict", true, {
      reason: "temporary_file_changed",
    });
  }
  const resolved = await realpath(tempPath);
  const expectedResolved = path.join(
    await realpath(path.dirname(tempPath)),
    path.basename(tempPath),
  );
  if (
    resolved !== expectedResolved ||
    !sameIdentity(await stat(resolved), expected)
  ) {
    throw fileError("conflict", true, {
      reason: "temporary_file_changed",
    });
  }
}

async function readBytes(
  handle: FileHandle,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const initialInfo = await handle.stat();
  if (initialInfo.size > maxBytes) {
    throw fileError("output_limit", false, {
      maxBytes,
      size: initialInfo.size,
    });
  }

  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    throwIfCancelled(signal);
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw fileError("output_limit", false, { maxBytes, size: total });
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function writeCompleteFile(
  handle: FileHandle,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    throwIfCancelled(signal);
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesWritten === 0) {
      throw fileError("internal_error", true, {
        reason: "zero_length_write",
      });
    }
    offset += bytesWritten;
  }
}

async function openRandomTemp(
  directory: string,
  basename: string,
): Promise<{ path: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tempPath = path.join(
      directory,
      `.${basename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      return { path: tempPath, handle: await open(tempPath, "wx", 0o600) };
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
  }
  throw fileError("internal_error", true, {
    reason: "temporary_name_exhausted",
  });
}

async function acquireEditLock(
  lockPath: string,
  logicalPath: string,
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: FileHandle | undefined;

    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await handle.sync();
      return handle;
    } catch (error: unknown) {
      if (handle) {
        const identity = await handle.stat().catch(() => undefined);
        await handle.close().catch(() => undefined);
        await releaseEditLock(lockPath, identity).catch(() => undefined);
      }

      if (
        nodeErrorCode(error) !== "EEXIST" ||
        attempt > 0 ||
        !(await removeStaleEditLock(lockPath))
      ) {
        if (nodeErrorCode(error) === "EEXIST") {
          throw fileError("conflict", true, {
            path: logicalPath,
            reason: "concurrent_edit",
          });
        }
        throw error;
      }
    }
  }

  throw fileError("conflict", true, {
    path: logicalPath,
    reason: "concurrent_edit",
  });
}

async function removeStaleEditLock(lockPath: string): Promise<boolean> {
  const pathInfo = await lstat(lockPath).catch(() => undefined);

  if (!pathInfo?.isFile() || pathInfo.isSymbolicLink() || pathInfo.size > 1_024) {
    return false;
  }

  const handle = await open(lockPath, "r").catch(() => undefined);

  if (!handle) {
    return false;
  }

  try {
    const openedInfo = await handle.stat();

    if (!sameIdentity(pathInfo, openedInfo)) {
      return false;
    }

    const raw = await handle.readFile("utf8");
    const owner = parseLockOwner(raw);
    const oldEnough = Date.now() - openedInfo.mtimeMs > 24 * 60 * 60 * 1_000;

    if (!owner && !oldEnough) {
      return false;
    }

    if (owner && isProcessAlive(owner.pid) && !oldEnough) {
      return false;
    }

    const currentInfo = await lstat(lockPath).catch(() => undefined);

    if (!currentInfo || !sameIdentity(currentInfo, openedInfo)) {
      return false;
    }

    await unlink(lockPath);
    return true;
  } finally {
    await handle.close();
  }
}

async function releaseEditLock(
  lockPath: string,
  expected?: Identity,
): Promise<void> {
  if (!expected) {
    return;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await lstat(lockPath).catch(() => undefined);

    if (!current || !current.isFile() || !sameIdentity(current, expected)) {
      return;
    }

    try {
      await unlink(lockPath);
      return;
    } catch (error: unknown) {
      if (
        !["EACCES", "EPERM", "EBUSY"].includes(nodeErrorCode(error) ?? "") ||
        attempt === 3
      ) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

function parseLockOwner(raw: string): { pid: number } | undefined {
  try {
    const value = JSON.parse(raw) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isSafeInteger(value.pid)
      ? { pid: value.pid }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid < 1) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return nodeErrorCode(error) !== "ESRCH";
  }
}

function encodeText(
  text: string,
  maxBytes: number,
  logicalPath: string,
  preserveBom = false,
): Buffer {
  if (text.includes("\0")) {
    throw fileError("binary_file", false, {
      path: logicalPath,
      reason: "nul_character",
    });
  }
  const content = Buffer.from(text, "utf8");
  const bytes =
    preserveBom && !hasUtf8Bom(content)
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content])
      : content;
  if (bytes.length > maxBytes) {
    throw fileError("output_limit", false, {
      path: logicalPath,
      maxBytes,
      size: bytes.length,
    });
  }
  return bytes;
}

function decodeText(bytes: Buffer, logicalPath: string): string {
  if (bytes.includes(0) || looksBinary(bytes)) {
    throw fileError("binary_file", false, { path: logicalPath });
  }
  try {
    const content = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw fileError("invalid_encoding", false, { path: logicalPath });
  }
}

function looksBinary(bytes: Buffer): boolean {
  let controls = 0;
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      controls += 1;
    }
  }
  return controls >= 3 && controls / Math.max(bytes.length, 1) > 0.1;
}

function snapshotFromBytes(
  workspaceRoot: string,
  logicalPath: string,
  absolutePath: string,
  text: string,
  bytes: Buffer,
  mode: number,
  identity: Identity,
): TextFileSnapshot {
  return {
    workspaceRoot,
    logicalPath,
    absolutePath,
    text: hasUtf8Bom(bytes) && text.startsWith("\ufeff") ? text.slice(1) : text,
    hash: sha256(bytes),
    size: bytes.length,
    mode: normalizeMode(mode),
    bom: hasUtf8Bom(bytes),
    lineEnding: detectLineEnding(text),
    dev: identity.dev,
    ino: identity.ino,
  };
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  );
}

async function assertNoSymlinkComponents(
  workspaceRoot: string,
  targetPath: string,
  logicalPath: string,
): Promise<void> {
  const relative = path.relative(workspaceRoot, targetPath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = workspaceRoot;

  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    });

    if (!info) {
      break;
    }

    if (info.isSymbolicLink()) {
      throw fileError("conflict", false, {
        path: logicalPath,
        reason: "symlink_component_denied",
      });
    }
  }
}

function traversalRoot(
  workspaceRoot: string,
  targetPath: string,
  outsideRoot: string,
): string {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
    ? workspaceRoot
    : outsideRoot;
}

async function renameWithRetry(
  source: string,
  destination: string,
): Promise<void> {
  const retryable = new Set(["EACCES", "EPERM", "EBUSY"]);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error: unknown) {
      if (!retryable.has(nodeErrorCode(error) ?? "") || attempt === 3) {
        throw error;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 25 * 2 ** attempt),
      );
    }
  }
}

function detectLineEnding(text: string): TextFileLineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (kinds === 0) return "none";
  if (kinds > 1 || cr > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

function normalizeMaxBytes(value?: number): number {
  if (value === undefined) return DEFAULT_MAX_TEXT_FILE_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fileError("internal_error", false, {
      reason: "invalid_max_bytes",
      maxBytes: value,
    });
  }
  return value;
}

function normalizeMode(mode: number): number {
  return mode & 0o777;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function fileError(
  code: FileOperationErrorCode,
  retryable: boolean,
  details: Record<string, unknown>,
): FileOperationError {
  return new FileOperationError(code, retryable, details);
}

function mapError(
  error: unknown,
  logicalPath: string,
  signal?: AbortSignal,
): Error {
  if (error instanceof FileOperationError || isCancellationError(error, signal)) {
    return error as Error;
  }
  const code = nodeErrorCode(error);
  if (code === "ENOENT") {
    return fileError("not_found", false, { path: logicalPath });
  }
  if (code === "EEXIST") {
    return fileError("conflict", true, {
      path: logicalPath,
      reason: "already_exists",
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return fileError("permission_denied", false, { path: logicalPath });
  }
  return fileError("internal_error", false, {
    path: logicalPath,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function messageForCode(code: FileOperationErrorCode): string {
  return {
    not_found: "Text file not found.",
    conflict: "Text file changed or already exists.",
    output_limit: "Text file exceeds the byte limit.",
    invalid_encoding: "Text file is not valid UTF-8.",
    binary_file: "Binary files are not supported.",
    permission_denied: "Permission denied.",
    internal_error: "Text file operation failed.",
  }[code];
}
