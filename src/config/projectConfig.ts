import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentBudget } from "../agent/budget.js";
import type { ModelPricing } from "../model/base.js";

const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const positiveFiniteNumber = z.number().positive();

const projectBudgetSchema = z
  .object({
    maxTurns: positiveInteger.optional(),
    maxWallTimeMs: positiveInteger.optional(),
    maxInputTokens: positiveInteger.optional(),
    maxOutputTokens: positiveInteger.optional(),
    maxToolCalls: nonNegativeInteger.optional(),
    maxModelRetries: nonNegativeInteger.optional(),
    maxEstimatedCostUsd: positiveFiniteNumber.optional(),
  })
  .strict();

export const projectConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    budget: projectBudgetSchema.optional(),
    memory: z.object({ enabled: z.literal(false) }).strict().optional(),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface ProjectRestrictionTarget {
  budget: AgentBudget;
  memoryEnabled: boolean;
}

export function defaultProjectConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".harness.json");
}

export async function loadProjectConfig(
  workspaceRoot: string,
): Promise<ProjectConfig> {
  const configPath = defaultProjectConfigPath(workspaceRoot);
  let initialInfo;

  try {
    initialInfo = await lstat(configPath);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return projectConfigSchema.parse({});
    }
    throw error;
  }

  assertSafeConfigFile(initialInfo);

  let handle;
  try {
    handle = await open(
      configPath,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  } catch (error: unknown) {
    if (hasCode(error, "ELOOP")) {
      throw new Error("Refusing a symbolic link project config.");
    }
    throw error;
  }

  try {
    const [pathInfo, handleInfo] = await Promise.all([
      lstat(configPath),
      handle.stat(),
    ]);
    assertSameConfigFile(pathInfo, handleInfo);
    const text = await readLimitedUtf8(handle);
    const finalPathInfo = await lstat(configPath);
    assertSameConfigFile(finalPathInfo, handleInfo);
    return projectConfigSchema.parse(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`Project config is not valid JSON: ${error.message}`);
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export function applyProjectRestrictions(
  base: Readonly<ProjectRestrictionTarget>,
  project: Readonly<ProjectConfig>,
  options: { pricing?: Readonly<ModelPricing> } = {},
): ProjectRestrictionTarget {
  const validatedProject = projectConfigSchema.parse(project);
  const restrictions = validatedProject.budget;

  if (
    restrictions?.maxEstimatedCostUsd !== undefined &&
    !hasValidPricing(options.pricing)
  ) {
    throw new Error(
      "Project maxEstimatedCostUsd requires non-zero model pricing.",
    );
  }

  return {
    budget: {
      maxTurns: restricted(
        base.budget.maxTurns,
        restrictions?.maxTurns,
      ),
      maxWallTimeMs: restricted(
        base.budget.maxWallTimeMs,
        restrictions?.maxWallTimeMs,
      ),
      maxInputTokens: restricted(
        base.budget.maxInputTokens,
        restrictions?.maxInputTokens,
      ),
      maxOutputTokens: restricted(
        base.budget.maxOutputTokens,
        restrictions?.maxOutputTokens,
      ),
      maxToolCalls: restricted(
        base.budget.maxToolCalls,
        restrictions?.maxToolCalls,
      ),
      maxModelRetries: restricted(
        base.budget.maxModelRetries,
        restrictions?.maxModelRetries,
      ),
      ...restrictedOptionalCost(
        base.budget.maxEstimatedCostUsd,
        restrictions?.maxEstimatedCostUsd,
      ),
    },
    memoryEnabled:
      base.memoryEnabled && validatedProject.memory?.enabled !== false,
  };
}

async function readLimitedUtf8(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_PROJECT_CONFIG_BYTES + 1);
  let offset = 0;

  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }

  if (offset > MAX_PROJECT_CONFIG_BYTES) {
    throw new Error("Project config exceeds the 1 MiB safety limit.");
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function assertSafeConfigFile(info: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Refusing a symbolic link or non-file project config.");
  }
  if (info.size > MAX_PROJECT_CONFIG_BYTES) {
    throw new Error("Project config exceeds the 1 MiB safety limit.");
  }
}

function assertSameConfigFile(
  pathInfo: {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    dev: number;
    ino: number;
  },
  handleInfo: {
    isFile(): boolean;
    size: number;
    dev: number;
    ino: number;
  },
): void {
  if (
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    !handleInfo.isFile() ||
    pathInfo.dev !== handleInfo.dev ||
    pathInfo.ino !== handleInfo.ino
  ) {
    throw new Error("Project config changed while it was being opened.");
  }
  if (
    pathInfo.size > MAX_PROJECT_CONFIG_BYTES ||
    handleInfo.size > MAX_PROJECT_CONFIG_BYTES
  ) {
    throw new Error("Project config exceeds the 1 MiB safety limit.");
  }
}

function restricted(current: number, limit: number | undefined): number {
  return limit === undefined ? current : Math.min(current, limit);
}

function restrictedOptionalCost(
  current: number | undefined,
  limit: number | undefined,
): Partial<Pick<AgentBudget, "maxEstimatedCostUsd">> {
  if (current === undefined && limit === undefined) {
    return {};
  }
  return {
    maxEstimatedCostUsd:
      current === undefined
        ? limit
        : limit === undefined
          ? current
          : Math.min(current, limit),
  };
}

function hasValidPricing(
  pricing: Readonly<ModelPricing> | undefined,
): boolean {
  if (!pricing) {
    return false;
  }
  const values = [
    pricing.inputPerMillionTokens,
    pricing.outputPerMillionTokens,
    pricing.cacheReadPerMillionTokens ?? 0,
  ];
  return (
    values.every((value) => Number.isFinite(value) && value >= 0) &&
    (pricing.inputPerMillionTokens > 0 ||
      pricing.outputPerMillionTokens > 0)
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
