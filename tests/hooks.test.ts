import { describe, expect, it, vi } from "vitest";
import { protectSensitiveWrites } from "../src/hooks/defaults.js";
import { HookManager } from "../src/hooks/manager.js";

describe("HookManager", () => {
  it("runs handlers in order and stops at the first block", async () => {
    const manager = new HookManager();
    const last = vi.fn();
    manager.register("BeforeToolUse", () => ({ decision: "allow" }));
    manager.register("BeforeToolUse", () => ({
      decision: "block",
      reason: "blocked",
    }));
    manager.register("BeforeToolUse", last);

    await expect(manager.emit("BeforeToolUse", {})).resolves.toMatchObject({
      decision: "block",
      reason: "blocked",
    });
    expect(last).not.toHaveBeenCalled();
  });

  it("reports whether an event has registered handlers", () => {
    const manager = new HookManager();

    expect(manager.has("BeforeAgentStop")).toBe(false);
    manager.register("BeforeAgentStop", () => null);
    expect(manager.has("BeforeAgentStop")).toBe(true);
  });

  it("blocks sensitive and oversized writes", () => {
    expect(
      protectSensitiveWrites({
        toolCall: {
          id: "1",
          name: "Write",
          args: { file_path: ".env.local", content: "secret" },
        },
      }),
    ).toMatchObject({ decision: "block" });

    expect(
      protectSensitiveWrites({
        toolCall: {
          id: "2",
          name: "Edit",
          args: {
            file_path: "src/large.ts",
            new_string: "x".repeat(1_000_001),
          },
        },
      }),
    ).toMatchObject({ decision: "block" });
  });
});
