import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import type { SessionEvent, SessionEventInput } from "./types.js";

export class SessionStore {
  constructor(private readonly filePath: string) {}

  async append(event: SessionEventInput): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const fullEvent = {
      ts: new Date().toISOString(),
      ...event,
    } as SessionEvent;
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
        throw new Error("Refusing to append to a symbolic link or replaced session file.");
      }

      const prefix = await repairUnterminatedTail(handle);
      await handle.writeFile(`${prefix}${JSON.stringify(fullEvent)}\n`, "utf8");
    } finally {
      await handle.close();
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
          events.push(JSON.parse(line) as SessionEvent);
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
