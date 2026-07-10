import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  parseInputFormat,
  parseOutputFormat,
  resolveTaskInput,
} from "../src/cli/io.js";

describe("CLI machine I/O", () => {
  it("validates stable input and output formats", () => {
    expect(parseOutputFormat("json")).toBe("json");
    expect(parseOutputFormat("stream-json")).toBe("stream-json");
    expect(() => parseOutputFormat("xml")).toThrow("--output-format");
    expect(parseInputFormat("text")).toBe("text");
    expect(() => parseInputFormat("json")).toThrow("--input-format");
  });

  it("reads plain text from stdin without overriding an explicit task", async () => {
    await expect(
      resolveTaskInput(undefined, "text", Readable.from(["inspect ", "this\n"])),
    ).resolves.toBe("inspect this");
    await expect(
      resolveTaskInput("explicit", "text", Readable.from(["ignored"])),
    ).resolves.toBe("explicit");
  });

  it("accepts a stream of user messages and rejects malformed records", async () => {
    await expect(
      resolveTaskInput(
        undefined,
        "stream-json",
        Readable.from([
          '{"type":"user","text":"first"}\n',
          '{"type":"user","text":"second"}\n',
        ]),
      ),
    ).resolves.toBe("first\n\nsecond");
    await expect(
      resolveTaskInput(undefined, "stream-json", Readable.from(["not-json\n"])),
    ).rejects.toThrow("line 1");
  });
});
