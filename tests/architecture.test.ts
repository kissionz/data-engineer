import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const limits = {
  "src/index.ts": 1_000,
  "src/agent/loop.ts": 1_300,
  "src/model/openai.ts": 1_300,
  "src/agent/session.ts": 500,
  "src/memory/store.ts": 600,
  "src/telemetry/sink.ts": 500,
} as const;

describe("module boundaries", () => {
  it.each(Object.entries(limits))(
    "keeps %s below the agreed structural limit",
    async (filePath, maxLines) => {
      const source = await readFile(path.resolve(filePath), "utf8");
      const lines = source.split("\n").length;
      expect(lines, `${filePath} has grown beyond ${maxLines} lines`).toBeLessThanOrEqual(
        maxLines,
      );
    },
  );
});
