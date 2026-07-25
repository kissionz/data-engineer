import path from "node:path";
import {
  defaultUserConfigPath,
  loadUserConfig,
} from "../config/userConfig.js";
import {
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
    envFilePath: envSelection.filePath,
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
  assertModelConfiguration(value);
  return value;
}

function providerBaseUrlEnvironment(provider: ModelProvider): string {
  if (provider === "anthropic") return "ANTHROPIC_BASE_URL";
  if (provider === "gemini") return "GEMINI_BASE_URL";
  return "OPENAI_BASE_URL";
}
