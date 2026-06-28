import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionCompactor } from "../src/agent/compaction.js";
import { ContextBuilder } from "../src/agent/context.js";
import { AgentLoop } from "../src/agent/loop.js";
import { SessionStore } from "../src/agent/session.js";
import type { AgentResponse } from "../src/agent/types.js";
import { HookManager } from "../src/hooks/manager.js";
import type { ModelClient } from "../src/model/base.js";
import { PermissionGate } from "../src/permissions/gate.js";
import { defaultPolicy } from "../src/permissions/policy.js";
import {
  discoverRuntimeCapabilities,
} from "../src/runtime/capabilities.js";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "../src/runtime/commandExecutor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { sanitizeTelemetryEvent } from "../src/telemetry/sanitize.js";

const successfulCommand = (stdout: string): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  cancelled: false,
});

class ProbingExecutor implements CommandExecutor {
  readonly calls: CommandOptions[] = [];

  async run(options: CommandOptions): Promise<CommandResult> {
    this.calls.push(options);
    const key = `${options.command} ${options.args.join(" ")}`;

    if (key === "git --version") {
      return successfulCommand("git version 2.50.0\n");
    }
    if (key === "rg --version") {
      return successfulCommand("ripgrep 14.1.1\n");
    }
    if (key === "git rev-parse --is-inside-work-tree") {
      return successfulCommand(" true \n");
    }

    throw new Error(`Unexpected capability probe: ${key}`);
  }
}

class FinalModel implements ModelClient {
  async complete(): Promise<AgentResponse> {
    return { finalText: "done", stopReason: "end_turn" };
  }
}

async function createLoopFixture(options: {
  hooks?: HookManager;
  compactor?: SessionCompactor;
  root?: string;
  session?: SessionStore;
} = {}): Promise<{ loop: AgentLoop; session: SessionStore }> {
  const root =
    options.root ??
    await mkdtemp(path.join(os.tmpdir(), "harness-closeout-"));
  const session =
    options.session ??
    new SessionStore(path.join(root, ".harness", "sessions", "test.jsonl"));
  const loop = new AgentLoop(
    new FinalModel(),
    new ToolRegistry(),
    new PermissionGate(defaultPolicy()),
    new ContextBuilder(root),
    session,
    10,
    undefined,
    undefined,
    options.compactor,
    options.hooks,
  );

  return { loop, session };
}

describe("closeout runtime capabilities", () => {
  it("probes git, ripgrep, and repository status through the executor", async () => {
    const executor = new ProbingExecutor();

    await expect(
      discoverRuntimeCapabilities(executor, "/workspace/project"),
    ).resolves.toEqual({
      git: true,
      ripgrep: true,
      gitRepository: true,
    });
    expect(executor.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "git",
          args: ["--version"],
          cwd: "/workspace/project",
          timeoutMs: 5_000,
          maxOutputChars: 2_000,
        }),
        expect.objectContaining({
          command: "rg",
          args: ["--version"],
          cwd: "/workspace/project",
          timeoutMs: 5_000,
          maxOutputChars: 2_000,
        }),
        expect.objectContaining({
          command: "git",
          args: ["rev-parse", "--is-inside-work-tree"],
          cwd: "/workspace/project",
          timeoutMs: 5_000,
          maxOutputChars: 2_000,
        }),
      ]),
    );
    expect(executor.calls).toHaveLength(3);
  });

  it("reports unavailable optional commands without throwing", async () => {
    const executor: CommandExecutor = {
      async run() {
        return {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "command not found",
          timedOut: false,
          cancelled: false,
        };
      },
    };

    await expect(
      discoverRuntimeCapabilities(executor, "/workspace/project"),
    ).resolves.toEqual({
      git: false,
      ripgrep: false,
      gitRepository: false,
    });
  });
});

describe("closeout lifecycle hooks", () => {
  it("emits SessionStart only for the first run of one AgentLoop", async () => {
    const hooks = new HookManager();
    const tasks: unknown[] = [];
    hooks.register("SessionStart", (payload) => {
      tasks.push(payload.userTask);
      return { decision: "allow" };
    });
    const { loop } = await createLoopFixture({ hooks });

    await expect(loop.run("first task")).resolves.toBe("done");
    await expect(loop.run("follow-up task")).resolves.toBe("done");

    expect(tasks).toEqual(["first task"]);
  });

  it("lets PreCompact observe and block a pending compaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-closeout-"));
    const session = new SessionStore(
      path.join(root, ".harness", "sessions", "test.jsonl"),
    );
    const hooks = new HookManager();
    const observations: Array<Record<string, unknown>> = [];
    hooks.register("PreCompact", (payload) => {
      observations.push(payload);
      return { decision: "block", reason: "retain full history" };
    });
    const { loop } = await createLoopFixture({
      root,
      session,
      hooks,
      compactor: new SessionCompactor(session, 1, 100_000),
    });

    await expect(loop.run("keep this context")).resolves.toBe("done");

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      eventCount: expect.any(Number),
      estimatedTokens: expect.any(Number),
    });
    expect(observations[0]?.eventCount).toBeGreaterThan(0);
    expect((await session.load()).some((event) => event.type === "summary")).toBe(
      false,
    );
  });
});

describe("closeout cost telemetry", () => {
  it("preserves a finite estimated model cost", () => {
    expect(
      sanitizeTelemetryEvent({
        type: "model_request_finished",
        taskId: "task-1",
        provider: "openai",
        model: "priced-model",
        outcome: "succeeded",
        durationMs: 10,
        inputTokens: 100,
        outputTokens: 20,
        estimatedCostUsd: 0.001,
      }),
    ).toMatchObject({
      type: "model_request_finished",
      estimatedCostUsd: 0.001,
    });
  });
});
