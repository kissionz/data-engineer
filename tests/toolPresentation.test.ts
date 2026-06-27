import { describe, expect, it } from "vitest";
import {
  summarizeApproval,
  summarizeToolCall,
} from "../src/ui/toolPresentation.js";

describe("summarizeToolCall", () => {
  it("shows concise file and command summaries", () => {
    expect(
      summarizeToolCall({
        id: "1",
        name: "Edit",
        args: {
          file_path: "src/index.ts",
          old_string: "very long file content",
          new_string: "replacement",
        },
      }),
    ).toBe("Edit src/index.ts");

    const summary = summarizeToolCall({
      id: "2",
      name: "Bash",
      args: { command: `node ${"x".repeat(150)}` },
    });

    expect(summary).toMatch(/^Bash node /);
    expect(summary.length).toBeLessThanOrEqual(105);
    expect(summary).not.toContain("x".repeat(150));
  });

  it("shows a bounded edit preview for approval", () => {
    const detail = summarizeApproval({
      id: "1",
      name: "Edit",
      args: {
        file_path: "src/index.ts",
        old_string: `old ${"x".repeat(80)}`,
        new_string: "new value",
      },
    });

    expect(detail).toContain("old ");
    expect(detail).toContain("new value");
    expect(detail?.length).toBeLessThan(90);
  });

  it("summarizes skill discovery and loading", () => {
    expect(
      summarizeToolCall({ id: "1", name: "SkillList", args: {} }),
    ).toBe("Skill list");
    expect(
      summarizeToolCall({
        id: "2",
        name: "SkillLoad",
        args: { name: "typescript-testing" },
      }),
    ).toBe("Skill load typescript-testing");
  });
});
