#!/usr/bin/env node

import { Command } from "commander";
import { LocalCommandExecutor } from "../runtime/localExecutor.js";
import { inspectWorktrees } from "../runtime/worktreeReport.js";

const program = new Command()
  .name("harness-worktrees")
  .description("List Git worktrees and inspect their status without modifying them")
  .option("--cwd <path>", "Repository or worktree path", process.cwd())
  .parse();

const options = program.opts<{ cwd: string }>();

void inspectWorktrees(new LocalCommandExecutor(), options.cwd)
  .then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
