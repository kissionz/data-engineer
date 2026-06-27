export type BashSandboxMode = "auto" | "docker" | "host" | "off";
export type SandboxPullPolicy = "missing" | "never";
export type SandboxNetwork = "none" | "bridge";

export interface SandboxConfig {
  mode: BashSandboxMode;
  image: string;
  pull: SandboxPullPolicy;
  network: SandboxNetwork;
  memory: string;
  cpus: number;
  pids: number;
}

export interface RawSandboxConfig {
  mode?: string;
  image?: string;
  pull?: string;
  network?: string;
  memory?: string;
  cpus?: string;
  pids?: string;
}

export function parseSandboxConfig(raw: RawSandboxConfig): SandboxConfig {
  return {
    mode: oneOf(
      raw.mode ?? "auto",
      ["auto", "docker", "host", "off"],
      "--bash-sandbox",
    ),
    image: requiredText(raw.image ?? "node:22-bookworm", "--sandbox-image"),
    pull: oneOf(
      raw.pull ?? "never",
      ["missing", "never"],
      "--sandbox-pull",
    ),
    network: oneOf(
      raw.network ?? "none",
      ["none", "bridge"],
      "--sandbox-network",
    ),
    memory: validateMemory(raw.memory ?? "1g"),
    cpus: positiveNumber(raw.cpus ?? "2", "--sandbox-cpus"),
    pids: positiveInteger(raw.pids ?? "256", "--sandbox-pids"),
  };
}

function oneOf<T extends string>(
  value: string,
  choices: readonly T[],
  option: string,
): T {
  if (!choices.includes(value as T)) {
    throw new Error(`${option} must be one of: ${choices.join(", ")}.`);
  }

  return value as T;
}

function requiredText(value: string, option: string): string {
  if (!value.trim()) {
    throw new Error(`${option} cannot be empty.`);
  }

  return value.trim();
}

function validateMemory(value: string): string {
  if (!/^[1-9]\d*(?:[kmg])?$/i.test(value)) {
    throw new Error("--sandbox-memory must be a positive Docker memory value.");
  }

  return value;
}

function positiveNumber(value: string, option: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number.`);
  }

  return parsed;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }

  return parsed;
}
