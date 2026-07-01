import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { acquireFileLock } from "../runtime/fileLock.js";
import { isPathWithin } from "../runtime/pathSafety.js";

export type FolderGrantAccess = "read" | "read_write";
export type FolderGrantScope = "session" | "always";

export interface FolderGrantRequest {
  folder: string;
  access: FolderGrantAccess;
}

export interface VisibleFolderGrant extends FolderGrantRequest {
  scope: FolderGrantScope;
}

interface FolderGrantRecord extends FolderGrantRequest {
  createdAt: string;
}

interface FolderGrantFile {
  version: 1;
  grants: FolderGrantRecord[];
}

const MAX_GRANT_FILE_BYTES = 1024 * 1024;

export function defaultFolderGrantPath(userHome = homedir()): string {
  return path.join(
    userHome,
    ".harness",
    "permissions",
    "folder-grants.json",
  );
}

export class FolderGrantManager {
  private readonly sessionGrants: FolderGrantRecord[] = [];

  private constructor(
    private readonly filePath: string,
    private globalGrants: FolderGrantRecord[],
  ) {}

  static async load(
    filePath = defaultFolderGrantPath(),
  ): Promise<FolderGrantManager> {
    return new FolderGrantManager(filePath, await loadGrantFile(filePath));
  }

  allows(request: FolderGrantRequest): boolean {
    const normalized = normalizeRequest(request);
    return [...this.sessionGrants, ...this.globalGrants].some(
      (grant) =>
        accessAllows(grant.access, normalized.access) &&
        isPathWithin(grant.folder, normalized.folder),
    );
  }

  list(): VisibleFolderGrant[] {
    const visible = new Map<string, VisibleFolderGrant>();
    for (const grant of this.sessionGrants) {
      visible.set(`${grant.folder}\0${grant.access}`, {
        folder: grant.folder,
        access: grant.access,
        scope: "session",
      });
    }
    for (const grant of this.globalGrants) {
      visible.set(`${grant.folder}\0${grant.access}`, {
        folder: grant.folder,
        access: grant.access,
        scope: "always",
      });
    }
    return [...visible.values()].sort(
      (left, right) =>
        left.folder.localeCompare(right.folder) ||
        left.access.localeCompare(right.access),
    );
  }

  async grant(
    request: FolderGrantRequest,
    scope: FolderGrantScope,
  ): Promise<void> {
    const normalized = normalizeRequest(request);
    const record: FolderGrantRecord = {
      ...normalized,
      createdAt: new Date().toISOString(),
    };

    if (scope === "session") {
      addGrant(this.sessionGrants, record);
      return;
    }

    const latest = await persistGrant(this.filePath, record);
    this.globalGrants = latest;
  }
}

function normalizeRequest(request: FolderGrantRequest): FolderGrantRequest {
  if (
    request.access !== "read" &&
    request.access !== "read_write"
  ) {
    throw new Error("Folder grant access is invalid.");
  }
  if (
    typeof request.folder !== "string" ||
    !path.isAbsolute(request.folder) ||
    request.folder.includes("\0")
  ) {
    throw new Error("Folder grant path must be an absolute safe path.");
  }
  return {
    folder: path.resolve(request.folder),
    access: request.access,
  };
}

function addGrant(
  grants: FolderGrantRecord[],
  incoming: FolderGrantRecord,
): void {
  if (
    grants.some(
      (grant) =>
        grant.folder === incoming.folder &&
        accessAllows(grant.access, incoming.access),
    )
  ) {
    return;
  }
  for (let index = grants.length - 1; index >= 0; index -= 1) {
    const grant = grants[index];
    if (
      grant &&
      grant.folder === incoming.folder &&
      incoming.access === "read_write"
    ) {
      grants.splice(index, 1);
    }
  }
  grants.push(incoming);
}

function accessAllows(
  granted: FolderGrantAccess,
  requested: FolderGrantAccess,
): boolean {
  return granted === "read_write" || requested === "read";
}

async function loadGrantFile(filePath: string): Promise<FolderGrantRecord[]> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Refusing a symbolic link or non-file folder grant store.");
  }
  if (info.size > MAX_GRANT_FILE_BYTES) {
    throw new Error("Folder grant store exceeds the 1 MiB safety limit.");
  }

  const handle = await open(
    filePath,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  let raw: string;
  try {
    const [current, opened] = await Promise.all([
      lstat(filePath),
      handle.stat(),
    ]);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new Error("Folder grant store changed while opening.");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Folder grant store is invalid.");
  }
  const object = parsed as Record<string, unknown>;
  if (
    object.version !== 1 ||
    !Array.isArray(object.grants) ||
    Object.keys(object).some((key) => !["version", "grants"].includes(key))
  ) {
    throw new Error("Folder grant store is invalid.");
  }

  return object.grants.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Folder grant record is invalid.");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.folder !== "string" ||
      (record.access !== "read" && record.access !== "read_write") ||
      typeof record.createdAt !== "string" ||
      Number.isNaN(Date.parse(record.createdAt)) ||
      Object.keys(record).some(
        (key) => !["folder", "access", "createdAt"].includes(key),
      )
    ) {
      throw new Error("Folder grant record is invalid.");
    }
    return {
      ...normalizeRequest({
        folder: record.folder,
        access: record.access,
      }),
      createdAt: record.createdAt,
    };
  });
}

async function persistGrant(
  filePath: string,
  record: FolderGrantRecord,
): Promise<FolderGrantRecord[]> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Refusing an unsafe folder grant store directory.");
  }
  const release = await acquireFileLock(filePath, {
    label: "folder grant store",
  });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const grants = await loadGrantFile(filePath);
    addGrant(grants, record);
    const body = `${JSON.stringify({
      version: 1,
      grants,
    } satisfies FolderGrantFile, null, 2)}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_GRANT_FILE_BYTES) {
      throw new Error("Folder grant store would exceed the 1 MiB safety limit.");
    }
    await writeFile(tempPath, body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const handle = await open(tempPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    return grants;
  } finally {
    await unlink(tempPath).catch(() => undefined);
    await release();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
