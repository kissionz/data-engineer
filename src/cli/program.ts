import { Command } from "commander";
import { DEFAULT_AGENT_BUDGET } from "../agent/budget.js";

export interface CliOptions {
  task?: string;
  config?: string;
  envFile?: string;
  cwd: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  apiStyle?: string;
  maxTurns: string;
  maxWallTimeMs: string;
  maxInputTokens: string;
  maxOutputTokens: string;
  maxToolCalls: string;
  maxModelRetries: string;
  resume?: string;
  bashSandbox: string;
  sandboxImage: string;
  sandboxPull: string;
  sandboxNetwork: string;
  sandboxMemory: string;
  sandboxCpus: string;
  sandboxPids: string;
  worktree: boolean;
  worktreeBase: string;
}

export function parseCli(): { program: Command; options: CliOptions } {
  const program = new Command();
  program
    .name("harness")
    .description("TypeScript local coding agent harness")
    .option("-t, --task <task>", "Task to run")
    .option("--config <path>", "Trusted user config file")
    .option("--env-file <path>", "Explicit environment file to load")
    .option("--cwd <cwd>", "Workspace directory", process.cwd())
    .option("--provider <provider>", "Model provider: openai or mock", "openai")
    .option("--model <model>", "Model name")
    .option("--base-url <baseUrl>", "OpenAI-compatible API base URL")
    .option(
      "--api-style <style>",
      "API style: responses (OpenAI native) or chat_completions (compatible)",
    )
    .option("--max-turns <turns>", "Maximum agent turns per user message", "50")
    .option(
      "--max-wall-time-ms <milliseconds>",
      "Maximum wall time per user message",
      String(DEFAULT_AGENT_BUDGET.maxWallTimeMs),
    )
    .option(
      "--max-input-tokens <tokens>",
      "Maximum provider input tokens per user message",
      String(DEFAULT_AGENT_BUDGET.maxInputTokens),
    )
    .option(
      "--max-output-tokens <tokens>",
      "Maximum provider output tokens per user message",
      String(DEFAULT_AGENT_BUDGET.maxOutputTokens),
    )
    .option(
      "--max-tool-calls <calls>",
      "Maximum tool calls per user message",
      String(DEFAULT_AGENT_BUDGET.maxToolCalls),
    )
    .option(
      "--max-model-retries <retries>",
      "Maximum model retries per user message",
      String(DEFAULT_AGENT_BUDGET.maxModelRetries),
    )
    .option("--resume <session>", "Resume a session id or latest")
    .option(
      "--bash-sandbox <mode>",
      "Bash execution: auto, docker, host, or off",
      "auto",
    )
    .option(
      "--sandbox-image <image>",
      "Docker sandbox image",
      "node:22-bookworm",
    )
    .option("--sandbox-pull <policy>", "Image pull: missing or never", "never")
    .option("--sandbox-network <mode>", "Container network: none or bridge", "none")
    .option("--sandbox-memory <limit>", "Container memory limit", "1g")
    .option("--sandbox-cpus <count>", "Container CPU limit", "2")
    .option("--sandbox-pids <count>", "Container process limit", "256")
    .option("--worktree", "Run the agent in a new isolated git worktree")
    .option("--worktree-base <ref>", "Git ref used for a new worktree", "HEAD")
    .parse();
  return { program, options: program.opts<CliOptions>() };
}

export function optionOrEnv(
  program: Command,
  optionName: string,
  optionValue: string,
  environmentName: string,
): string {
  return program.getOptionValueSource(optionName) === "default"
    ? process.env[environmentName] ?? optionValue
    : optionValue;
}

export function resolveStringOption(
  program: Command,
  optionName: string,
  optionValue: string,
  environmentName: string,
  configValue?: string,
): string {
  return program.getOptionValueSource(optionName) === "cli"
    ? optionValue
    : process.env[environmentName] ?? configValue ?? optionValue;
}

export function resolveOptionalStringOption(
  program: Command,
  optionName: string,
  optionValue: string | undefined,
  environmentName: string,
  configValue?: string,
): string | undefined {
  return program.getOptionValueSource(optionName) === "cli"
    ? optionValue
    : process.env[environmentName] ?? configValue ?? optionValue;
}

export function numericConfig(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

export function parseNonNegativeInteger(
  value: string,
  optionName: string,
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }
  return parsed;
}
