#!/usr/bin/env node

import { Command } from "commander";
import { homedir } from "node:os";
import path from "node:path";
import { readTelemetryReport } from "../telemetry/report.js";

const program = new Command()
  .name("harness-telemetry-report")
  .description("Build a content-free aggregate report from local telemetry JSONL")
  .option(
    "--file <path>",
    "Telemetry JSONL file",
    path.join(homedir(), ".harness", "telemetry", "telemetry.jsonl"),
  )
  .option(
    "--max-bytes <bytes>",
    "Maximum accepted input size",
    String(16 * 1024 * 1024),
  )
  .parse();

const options = program.opts<{ file: string; maxBytes: string }>();
const maxBytes = Number(options.maxBytes);

void readTelemetryReport(options.file, { maxBytes })
  .then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
