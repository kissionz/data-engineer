import { stdin } from "node:process";
import type { OutputFormat } from "../ui/machineReporter.js";

export type InputFormat = "text" | "stream-json";

export function parseOutputFormat(value: string): OutputFormat {
  if (["text", "json", "stream-json"].includes(value)) {
    return value as OutputFormat;
  }
  throw new Error("--output-format must be text, json, or stream-json.");
}

export function parseInputFormat(value: string): InputFormat {
  if (value === "text" || value === "stream-json") {
    return value;
  }
  throw new Error("--input-format must be text or stream-json.");
}

export async function resolveTaskInput(
  cliTask: string | undefined,
  inputFormat: InputFormat,
  input: NodeJS.ReadableStream = stdin,
): Promise<string | undefined> {
  if (cliTask !== undefined) {
    return cliTask;
  }
  if ((input as NodeJS.ReadStream).isTTY) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (inputFormat === "text") {
    return raw.trim() || undefined;
  }
  const messages: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid stream-json input at line ${index + 1}.`);
    }
    if (
      !value ||
      typeof value !== "object" ||
      (value as { type?: unknown }).type !== "user" ||
      typeof (value as { text?: unknown }).text !== "string"
    ) {
      throw new Error(
        `stream-json line ${index + 1} must be {"type":"user","text":"..."}.`,
      );
    }
    messages.push((value as { text: string }).text);
  }
  return messages.join("\n\n").trim() || undefined;
}
