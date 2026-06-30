import { readFile } from "node:fs/promises";
import path from "node:path";

export interface LoadEnvFileOptions {
  allowMissing?: boolean;
}

export interface EnvFileSelection {
  filePath: string;
  allowMissing: boolean;
  source: "cli" | "user_config" | "workspace";
}

export function selectEnvFile(options: {
  workspaceRoot: string;
  userConfigPath: string;
  cliEnvFile?: string;
  userEnvFile?: string;
}): EnvFileSelection {
  if (options.cliEnvFile) {
    return {
      filePath: path.resolve(options.workspaceRoot, options.cliEnvFile),
      allowMissing: false,
      source: "cli",
    };
  }

  if (options.userEnvFile) {
    return {
      filePath: path.resolve(
        path.dirname(path.resolve(options.userConfigPath)),
        options.userEnvFile,
      ),
      allowMissing: false,
      source: "user_config",
    };
  }

  return {
    filePath: path.join(path.resolve(options.workspaceRoot), ".env"),
    allowMissing: true,
    source: "workspace",
  };
}

export async function loadEnvFile(
  filePath: string,
  options: LoadEnvFileOptions = {},
): Promise<void> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (options.allowMissing && hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);

    if (!parsed || process.env[parsed.key] !== undefined) {
      continue;
    }

    process.env[parsed.key] = parsed.value;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");

  if (separatorIndex < 1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  const rawValue = trimmed.slice(separatorIndex + 1).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  return {
    key,
    value: unquote(rawValue),
  };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
