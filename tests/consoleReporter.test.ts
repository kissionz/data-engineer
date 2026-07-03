import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleReporter } from "../src/ui/consoleReporter.js";

describe("ConsoleReporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the Glob match count when the search succeeds", () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const reporter = new ConsoleReporter();

    reporter.onToolStatus(
      {
        id: "glob-1",
        name: "Glob",
        args: { pattern: "**/*.sql", path: "D:\\project" },
      },
      "succeeded",
      {
        ok: true,
        content: "No files matched.",
        data: { count: 0, files: [] },
      },
    );

    expect(output.join("")).toContain("[done, 0 matches]");
  });
});
