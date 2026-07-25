import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  defaultUserConfigPath,
  loadUserConfig,
} from "../config/userConfig.js";
import {
  loadEnvFile,
  loadStartupEnv,
  selectEnvFile,
} from "../runtime/env.js";
import {
  type ModelCapabilities,
  type ModelClient,
  type ModelPricing,
} from "./base.js";
import { AnthropicModel } from "./anthropic.js";
import { GeminiModel } from "./gemini.js";
import { MockModel } from "./mock.js";
import {
  OpenAIModel,
  parseApiStyle,
  type ApiStyle,
} from "./openai.js";

export type ModelProvider = "openai" | "anthropic" | "gemini" | "mock";

export interface ConfiguredModelOptions {
  workspaceRoot: string;
  configPath?: string;
  envFile?: string;
  provider?: ModelProvider;
  model?: string;
  baseUrl?: string;
  apiStyle?: ApiStyle;
}

export interface ConfiguredModelRuntime {
  client: ModelClient;
  provider: ModelProvider;
  model: string;
  configPath: string;
  envFilePath: string;
}

const execFileAsync = promisify(execFile);

export async function resolveConfiguredModel(
  options: ConfiguredModelOptions,
): Promise<ConfiguredModelRuntime> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const configPath = path.resolve(
    options.configPath ??
      process.env.MONTANE_CONFIG ??
      process.env.HARNESS_CONFIG ??
      defaultUserConfigPath(),
  );
  const userConfig = await loadUserConfig(configPath);
  const envSelection = selectEnvFile({
    workspaceRoot,
    userConfigPath: configPath,
    cliEnvFile: options.envFile,
    userEnvFile: userConfig.envFile,
  });
  await loadStartupEnv(
    envSelection,
    new URL("../index.js", import.meta.url).href,
  );
  const installedCliEnvFile =
    envSelection.source === "workspace"
      ? await loadInstalledCliEnvironment(initialProvider(options, userConfig))
      : undefined;

  const provider = normalizeProvider(
    options.provider ??
      process.env.MONTANE_PROVIDER ??
      process.env.OPENAI_PROVIDER ??
      userConfig.model?.provider ??
      "openai",
  );
  const model =
    options.model ??
    process.env.MONTANE_MODEL ??
    process.env.OPENAI_MODEL ??
    userConfig.model?.name ??
    defaultModelName(provider);
  const baseUrl =
    options.baseUrl ??
    process.env[providerBaseUrlEnvironment(provider)] ??
    userConfig.model?.baseUrl;
  const apiStyle =
    options.apiStyle ?? parseApiStyle(process.env.OPENAI_API_STYLE);

  return {
    client: createModelClient(
      provider,
      model,
      baseUrl,
      apiStyle,
      userConfig.model?.pricing,
      userConfig.model?.capabilities,
    ),
    provider,
    model,
    configPath,
    envFilePath: installedCliEnvFile ?? envSelection.filePath,
  };
}

export function createModelClient(
  provider: ModelProvider,
  model: string,
  baseUrl?: string,
  apiStyle?: ApiStyle,
  pricing?: ModelPricing,
  capabilities?: Partial<ModelCapabilities>,
): ModelClient {
  assertModelConfiguration(provider);

  if (provider === "mock") {
    return new MockModel();
  }
  if (provider === "anthropic") {
    return new AnthropicModel({
      apiKey: process.env.ANTHROPIC_API_KEY as string,
      model,
      baseUrl,
      pricing,
      capabilities,
    });
  }
  if (provider === "gemini") {
    return new GeminiModel({
      apiKey: process.env.GEMINI_API_KEY as string,
      model,
      baseUrl,
      pricing,
      capabilities,
    });
  }
  return new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY as string,
    model,
    baseUrl,
    apiStyle,
    pricing,
    capabilities,
  });
}

export function assertModelConfiguration(
  provider: string,
): asserts provider is ModelProvider {
  if (!["openai", "anthropic", "gemini", "mock"].includes(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "Montane model configuration is incomplete: OPENAI_API_KEY is unavailable.",
    );
  }
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Montane model configuration is incomplete: ANTHROPIC_API_KEY is unavailable.",
    );
  }
  if (provider === "gemini" && !process.env.GEMINI_API_KEY) {
    throw new Error(
      "Montane model configuration is incomplete: GEMINI_API_KEY is unavailable.",
    );
  }
}

export function defaultModelName(provider: ModelProvider): string {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  if (provider === "gemini") return "gemini-2.5-pro";
  return provider === "mock" ? "mock" : "gpt-4.1";
}

function normalizeProvider(value: string): ModelProvider {
  if (
    value === "openai" ||
    value === "anthropic" ||
    value === "gemini" ||
    value === "mock"
  ) {
    return value;
  }
  throw new Error(`Unknown provider: ${value}`);
}

function providerBaseUrlEnvironment(provider: ModelProvider): string {
  if (provider === "anthropic") return "ANTHROPIC_BASE_URL";
  if (provider === "gemini") return "GEMINI_BASE_URL";
  return "OPENAI_BASE_URL";
}

function initialProvider(
  options: ConfiguredModelOptions,
  userConfig: Awaited<ReturnType<typeof loadUserConfig>>,
): string {
  return (
    options.provider ??
    process.env.MONTANE_PROVIDER ??
    process.env.OPENAI_PROVIDER ??
    userConfig.model?.provider ??
    "openai"
  );
}

async function loadInstalledCliEnvironment(
  provider: string,
): Promise<string | undefined> {
  if (provider === "mock" || hasProviderCredential(provider)) return undefined;

  for (const candidate of await installedCliEnvCandidates()) {
    const envFile = resolveExistingFile(candidate);
    if (!envFile) continue;
    await loadEnvFile(envFile, { allowMissing: false });
    const configuredProvider =
      process.env.MONTANE_PROVIDER ??
      process.env.OPENAI_PROVIDER ??
      provider;
    if (
      configuredProvider === "mock" ||
      hasProviderCredential(configuredProvider)
    ) {
      return envFile;
    }
  }
  return undefined;
}

async function installedCliEnvCandidates(): Promise<string[]> {
  const candidates = [
    process.env.MONTANE_ENV_FILE,
    process.env.MONTANE_CODE_PATH
      ? path.join(process.env.MONTANE_CODE_PATH, ".env")
      : undefined,
  ].filter((value): value is string => Boolean(value));

  try {
    const npmExecutable = process.env.npm_execpath;
    const executable = npmExecutable
      ? process.execPath
      : process.platform === "win32"
        ? "npm.cmd"
        : "npm";
    const args = npmExecutable
      ? [npmExecutable, "root", "-g"]
      : ["root", "-g"];
    const { stdout } = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (stdout.trim()) {
      candidates.push(path.join(stdout.trim(), "montane-code", ".env"));
    }
  } catch {
    // A missing global npm installation does not prevent normal SDK config use.
  }

  return candidates;
}

function resolveExistingFile(candidate: string): string | undefined {
  try {
    const realPath = fs.realpathSync(path.resolve(candidate));
    return fs.statSync(realPath).isFile() ? realPath : undefined;
  } catch {
    return undefined;
  }
}

function hasProviderCredential(provider: string): boolean {
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === "gemini") return Boolean(process.env.GEMINI_API_KEY);
  return provider === "openai" && Boolean(process.env.OPENAI_API_KEY);
}
