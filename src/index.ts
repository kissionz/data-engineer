#!/usr/bin/env node

import { input } from "@inquirer/prompts";
import { Command } from "commander";
import path from "node:path";
import { AgentLoop } from "./agent/loop.js";
import { ContextBuilder } from "./agent/context.js";
import type { ModelClient } from "./model/base.js";
import { SessionStore } from "./agent/session.js";
import { MockModel } from "./model/mock.js";
import { OpenAIModel } from "./model/openai.js";
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

interface CliOptions {
  task?: string;
  cwd: string;
  provider: string;
  model?: string;
  baseUrl?: string;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("harness")
    .description("Claude Code-like TypeScript agent harness")
    .option("-t, --task <task>", "Task to run")
    .option("--cwd <cwd>", "Workspace directory", process.cwd())
    .option("--provider <provider>", "Model provider: openai or mock", "openai")
    .option("--model <model>", "Model name")
    .option("--base-url <baseUrl>", "OpenAI-compatible API base URL")
    .parse();

  const opts = program.opts<CliOptions>();
  const workspaceRoot = path.resolve(opts.cwd);
  await loadEnvFile(path.join(workspaceRoot, ".env"));

  const workspace = new Workspace(workspaceRoot);
  const executor = new LocalCommandExecutor();
  const tools = new ToolRegistry();
  const modelName = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1";
  const baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL;

  tools.register(new ReadTool(workspace));
  tools.register(new GrepTool(workspace, executor));
  tools.register(new EditTool(workspace));
  tools.register(new BashTool(workspace, executor));

  const agent = new AgentLoop(
    createModel(opts.provider, modelName, baseUrl),
    tools,
    new PermissionGate(defaultPolicy()),
    new ContextBuilder(workspaceRoot),
    new SessionStore(path.join(workspaceRoot, ".harness", "sessions", "latest.jsonl")),
  );

  const task =
    opts.task ??
    (await input({
      message: "Task",
    }));

  const result = await agent.run(task);

  console.log("\nFinal:\n");
  console.log(result);
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

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
