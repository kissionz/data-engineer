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

  it("cancels a hook that has not completed", async () => {
    const manager = new HookManager();
    const controller = new AbortController();
    manager.register(
      "BeforeAgentStop",
      () => new Promise(() => undefined),
    );

    const running = manager.emit(
      "BeforeAgentStop",
      {},
      controller.signal,
    );
    controller.abort();

    await expect(running).rejects.toMatchObject({
      name: "AgentCancelledError",
    });
  });

  it("provides the cancellation signal to hook handlers", async () => {
    const manager = new HookManager();
    const controller = new AbortController();
    let receivedSignal: unknown;
    manager.register("AfterToolUse", (payload) => {
      receivedSignal = payload.signal;
      return null;
    });

    await manager.emit("AfterToolUse", {}, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
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
