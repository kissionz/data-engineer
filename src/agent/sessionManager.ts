import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ManagedSession {
  id: string;
  sessionPath: string;
  todoPath: string;
}

export class SessionManager {
  private readonly sessionsDir: string;
  private readonly todosDir: string;
  private readonly currentFile: string;

  constructor(workspaceRoot: string) {
    const harnessDir = path.join(workspaceRoot, ".harness");
    this.sessionsDir = path.join(harnessDir, "sessions");
    this.todosDir = path.join(harnessDir, "todos");
    this.currentFile = path.join(this.sessionsDir, "current");
  }

  async start(resume?: string): Promise<ManagedSession> {
    return resume ? this.resume(resume) : this.create();
  }

  async create(): Promise<ManagedSession> {
    await mkdir(this.sessionsDir, { recursive: true });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = createSessionId();
      const session = this.describe(id);

      try {
        await writeFile(session.sessionPath, "", {
          encoding: "utf8",
          flag: "wx",
        });
        await this.setCurrent(id);
        return session;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new Error("Unable to allocate a unique session id.");
  }

  async resume(requestedId: string): Promise<ManagedSession> {
    const id =
      requestedId === "latest"
        ? await this.readCurrentOrLegacy()
        : validateSessionId(requestedId);
    const session = this.describe(id);
    const info = await stat(session.sessionPath).catch(() => null);

    if (!info?.isFile()) {
      throw new Error(`Session not found: ${id}`);
    }

    await this.setCurrent(id);
    return session;
  }

  async list(limit = 20): Promise<string[]> {
    const entries = await readdir(this.sessionsDir, {
      withFileTypes: true,
    }).catch(() => []);

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.slice(0, -".jsonl".length))
      .sort()
      .reverse()
      .slice(0, Math.max(1, limit));
  }

  private describe(id: string): ManagedSession {
    const safeId = validateSessionId(id);

    return {
      id: safeId,
      sessionPath: path.join(this.sessionsDir, `${safeId}.jsonl`),
      todoPath: path.join(this.todosDir, `${safeId}.json`),
    };
  }

  private async setCurrent(id: string): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.currentFile, `${validateSessionId(id)}\n`, "utf8");
  }

  private async readCurrentOrLegacy(): Promise<string> {
    try {
      return validateSessionId((await readFile(this.currentFile, "utf8")).trim());
    } catch (error: unknown) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw error;
      }
    }

    const legacyPath = path.join(this.sessionsDir, "latest.jsonl");
    const legacyInfo = await stat(legacyPath).catch(() => null);

    if (legacyInfo?.isFile()) {
      return "latest";
    }

    throw new Error("No previous session is available.");
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

function validateSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`Invalid session id: ${value}`);
  }

  return value;
}
