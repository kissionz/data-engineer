#!/usr/bin/env node

import { input } from "@inquirer/prompts";
import { Command } from "commander";
import path from "node:path";
import { AgentLoop } from "./agent/loop.js";
import { ContextBuilder } from "./agent/context.js";
import { SessionStore } from "./agent/session.js";
import { MockModel } from "./model/mock.js";
import { defaultPolicy } from "./permissions/policy.js";
import { PermissionGate } from "./permissions/gate.js";
import { LocalCommandExecutor } from "./runtime/localExecutor.js";
import { Workspace } from "./runtime/workspace.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { ReadTool } from "./tools/read.js";
import { ToolRegistry } from "./tools/registry.js";

const program = new Command();

program
  .name("harness")
  .description("Claude Code-like TypeScript agent harness")
  .option("-t, --task <task>", "Task to run")
  .option("--cwd <cwd>", "Workspace directory", process.cwd())
  .parse();

const opts = program.opts<{ task?: string; cwd: string }>();
const workspaceRoot = path.resolve(opts.cwd);
const workspace = new Workspace(workspaceRoot);
const executor = new LocalCommandExecutor();
const tools = new ToolRegistry();

tools.register(new ReadTool(workspace));
tools.register(new EditTool(workspace));
tools.register(new BashTool(workspace, executor));

const agent = new AgentLoop(
  new MockModel(),
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
