import { describe, expect, it } from "vitest";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "../src/runtime/commandExecutor.js";
import { unifiedDiff } from "../src/runtime/diff.js";
import { LocalShellExecutor } from "../src/runtime/localShellExecutor.js";
import type { Tool } from "../src/tools/base.js";
import { ToolRegistry } from "../src/tools/registry.js";

class RecordingExecutor implements CommandExecutor {
  calls: CommandOptions[] = [];

  async run(options: CommandOptions): Promise<CommandResult> {
    this.calls.push(options);
    return {
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
    };
  }
}

describe("hardening regressions", () => {
  it("enforces a tool timeout even when the tool ignores AbortSignal", async () => {
    const registry = new ToolRegistry();
    const slowTool: Tool = {
      name: "Slow",
      description: "Ignores cancellation.",
      inputSchema: { type: "object", additionalProperties: false },
      timeoutMs: 10,
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true, content: "late success" };
      },
    };
    registry.register(slowTool);

    await expect(registry.execute("Slow", {})).resolves.toMatchObject({
      ok: false,
      data: {
        code: "timeout",
        timeoutMs: 10,
      },
    });
  });

  it("fails closed when restricted host networking is unsupported", async () => {
    const executor = new RecordingExecutor();
    const shell = new LocalShellExecutor(executor, "restricted", "win32");

    const result = await shell.runScript({
      script: "echo should-not-run",
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      stderr: expect.stringContaining("command was not run"),
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("uses a zero-length old range when diffing an empty file", () => {
    expect(unifiedDiff("", "x\n", "file.txt")).toBe(
      [
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -0,0 +1,1 @@",
        "+x",
      ].join("\n"),
    );
  });

  it("marks a missing final newline in a standard unified diff", () => {
    expect(unifiedDiff("a\n", "a", "file.txt")).toBe(
      [
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1,1 +1,1 @@",
        "-a",
        "+a",
        "\\ No newline at end of file",
      ].join("\n"),
    );
  });
});
