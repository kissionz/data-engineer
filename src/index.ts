#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { AgentLoop } from "./agent/loop.js";
import { ContextBuilder } from "./agent/context.js";
import type { ModelClient } from "./model/base.js";
import { SessionStore } from "./agent/session.js";
import { MockModel } from "./model/mock.js";
import { OpenAIModel } from "./model/openai.js";
import {
  askUserApproval,
  restoreInputAfterApproval,
} from "./permissions/approval.js";
import { defaultPolicy } from "./permissions/policy.js";
import { PermissionGate } from "./permissions/gate.js";
import { loadEnvFile } from "./runtime/env.js";
import { LocalCommandExecutor } from "./runtime/localExecutor.js";
import { Workspace } from "./runtime/workspace.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { GrepTool } from "./tools/grep.js";
import { ReadTool } from "./tools/read.js";
import { ToolRegistry } from "./tools/registry.js";
import { WriteTool } from "./tools/write.js";
import { ConsoleReporter } from "./ui/consoleReporter.js";

interface CliOptions {
  task?: string;
  cwd: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  maxTurns: string;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("harness")
    .description("TypeScript local coding agent harness")
    .option("-t, --task <task>", "Task to run")
    .option("--cwd <cwd>", "Workspace directory", process.cwd())
    .option("--provider <provider>", "Model provider: openai or mock", "openai")
    .option("--model <model>", "Model name")
    .option("--base-url <baseUrl>", "OpenAI-compatible API base URL")
    .option("--max-turns <turns>", "Maximum agent turns per user message", "50")
    .parse();

  const opts = program.opts<CliOptions>();
  const workspaceRoot = path.resolve(opts.cwd);
  await loadEnvFile(path.join(workspaceRoot, ".env"));

  const workspace = new Workspace(workspaceRoot);
  const executor = new LocalCommandExecutor();
  const tools = new ToolRegistry();
  const modelName = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1";
  const baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL;
  const maxTurns = parsePositiveInteger(opts.maxTurns, "--max-turns");
  const interactivePrompt = opts.task ? undefined : new InteractivePrompt();

  tools.register(new ReadTool(workspace));
  tools.register(new GrepTool(workspace, executor));
  tools.register(new WriteTool(workspace));
  tools.register(new EditTool(workspace));
  tools.register(new BashTool(workspace, executor));

  const agent = new AgentLoop(
    createModel(opts.provider, modelName, baseUrl),
    tools,
    new PermissionGate(defaultPolicy()),
    new ContextBuilder(workspaceRoot),
    new SessionStore(path.join(workspaceRoot, ".harness", "sessions", "latest.jsonl")),
    maxTurns,
    interactivePrompt
      ? restoreInputAfterApproval(askUserApproval, () =>
          interactivePrompt.resumeInput(),
        )
      : askUserApproval,
    new ConsoleReporter(),
  );

  if (opts.task || !interactivePrompt) {
    if (!opts.task) {
      throw new Error("Task is required when interactive input is unavailable.");
    }

    await runTask(agent, opts.task);
    return;
  }

  await runInteractiveSession(agent, interactivePrompt);
}

async function runTask(agent: AgentLoop, task: string): Promise<void> {
  await agent.run(task);
}

async function runInteractiveSession(
  agent: AgentLoop,
  prompt: InteractivePrompt,
): Promise<void> {
  console.log("Interactive harness session started. Type /exit or /quit to stop.");

  try {
    while (true) {
      const task = await prompt.question("You ");

      if (prompt.shouldExitFromAnswer(task)) {
        console.log("Bye.");
        return;
      }

      const trimmed = task.trim();

      if (!trimmed) {
        continue;
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        console.log("Bye.");
        return;
      }

      await runTask(agent, trimmed);
    }
  } finally {
    prompt.close();
  }
}

function createModel(
  provider: string,
  model: string,
  baseUrl: string | undefined,
): ModelClient {
  if (provider === "mock") {
    return new MockModel();
  }

  if (provider !== "openai") {
    throw new Error(`Unknown provider: ${provider}`);
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      [
        "OPENAI_API_KEY is required for real model use.",
        "",
        "Set up your local environment:",
        "  1. cp .env.example .env",
        "  2. edit .env and set OPENAI_API_KEY=sk-...",
        "  3. npm start -- --task \"Inspect this project\"",
        "",
        "For loop-only development without an API call, run:",
        "  npm start -- --provider mock --task \"Inspect README.md\"",
      ].join("\n"),
    );
  }

  return new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY,
    model,
    baseUrl,
  });
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

class InteractivePrompt {
  private readonly rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  private terminationPending = false;

  constructor() {
    this.rl.on("SIGINT", () => {
      if (this.terminationPending) {
        this.close();
        process.exit(130);
      }

      this.terminationPending = true;
      this.rl.write(
        "\nTerminate session? Type y to exit, n to continue. Press Ctrl+C again to exit immediately.\n",
      );
    });
  }

  async question(prompt: string): Promise<string> {
    return this.rl.question(`${prompt}> `);
  }

  resumeInput(): void {
    this.rl.resume();
  }

  shouldExitFromAnswer(answer: string): boolean {
    if (!this.terminationPending) {
      return false;
    }

    const normalized = answer.trim().toLowerCase();

    if (["y", "yes"].includes(normalized)) {
      return true;
    }

    if (normalized === "") {
      return false;
    }

    this.terminationPending = false;
    return false;
  }

  close(): void {
    this.rl.close();
  }
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
