import { appendFile, mkdir, readFile } from "node:fs/promises";
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

    await appendFile(this.filePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
  }

  async load(): Promise<SessionEvent[]> {
    try {
      const text = await readFile(this.filePath, "utf8");

      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEvent);
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
