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

  it("collapses tool activity into one human-readable completion line", () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const ttyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      const reporter = new ConsoleReporter(undefined, true);
      const call = {
        id: "read-1",
        name: "Read",
        args: { file_path: "README.md" },
      };

      reporter.onToolStatus(call, "running");
      reporter.onToolStatus(call, "succeeded", {
        ok: true,
        content: "done",
      });
      reporter.onTextDelta("Finished");
      reporter.onTextEnd();

      const rendered = output.join("");
      expect(rendered).toContain("Read README.md");
      expect(rendered).toContain("✓ 1 tool");
      expect(rendered).not.toContain("tool events");
      reporter.dispose();
    } finally {
      if (ttyDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });
});
