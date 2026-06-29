import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Workspace } from "../runtime/workspace.js";
import {
  CODE_REVIEWER_SPEC,
  READONLY_SUBAGENT_TOOLS,
  type SubagentSpec,
} from "./spec.js";

export const MAX_SUBAGENT_SPEC_BYTES = 32 * 1024;
export const MAX_CONFIGURED_SUBAGENTS = 32;
export const MAX_SUBAGENT_TURNS = 20;
export const MAX_SUBAGENT_RESULT_CHARS = 20_000;

const agentName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const agentSpecSchema = z
  .object({
    name: agentName,
    description: z.string().trim().min(1).max(500),
    systemPrompt: z.string().trim().min(1).max(16_000),
    tools: z
      .array(z.enum(READONLY_SUBAGENT_TOOLS))
      .min(1)
      .max(READONLY_SUBAGENT_TOOLS.length)
      .refine(
        (tools) => new Set(tools).size === tools.length,
        "tools must not contain duplicates",
      ),
    maxTurns: z.number().int().min(1).max(MAX_SUBAGENT_TURNS),
    maxResultChars: z
      .number()
      .int()
      .min(1)
      .max(MAX_SUBAGENT_RESULT_CHARS),
  })
  .strict();

export class SubagentSpecLoader {
  private readonly workspaceRoot: string;
  private readonly agentsRoot: string;

  constructor(workspace: Workspace | string) {
    this.workspaceRoot = path.resolve(
      typeof workspace === "string" ? workspace : workspace.root,
    );
    this.agentsRoot = path.join(this.workspaceRoot, ".harness", "agents");
  }

  loadAll(): SubagentSpec[] {
    const configured = this.loadConfigured();
    return [CODE_REVIEWER_SPEC, ...configured].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  private loadConfigured(): SubagentSpec[] {
    const harnessRoot = path.dirname(this.agentsRoot);
    let harnessInfo;
    try {
      harnessInfo = lstatSync(harnessRoot);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    if (harnessInfo.isSymbolicLink() || !harnessInfo.isDirectory()) {
      throw new Error(
        "Subagent configuration parent must be a real directory, not a symlink.",
      );
    }

    let rootInfo;
    try {
      rootInfo = lstatSync(this.agentsRoot);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(
        "Subagent specs path must be a real directory, not a symlink.",
      );
    }

    const workspaceReal = realpathSync(this.workspaceRoot);
    const agentsReal = realpathSync(this.agentsRoot);
    assertPathWithin(
      workspaceReal,
      agentsReal,
      "Subagent specs directory resolves outside the workspace.",
    );

    const yamlNames = readdirSync(this.agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".yaml"))
      .map((entry) => {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(
            `Subagent spec must be a regular file: ${entry.name}`,
          );
        }
        return entry.name;
      })
      .sort();

    if (yamlNames.length > MAX_CONFIGURED_SUBAGENTS) {
      throw new Error(
        `At most ${MAX_CONFIGURED_SUBAGENTS} configured subagents are allowed.`,
      );
    }

    const seen = new Set<string>([CODE_REVIEWER_SPEC.name]);
    return yamlNames.map((fileName) => {
      const expectedName = fileName.slice(0, -".yaml".length);
      if (!agentName.safeParse(expectedName).success) {
        throw new Error(`Invalid subagent spec filename: ${fileName}`);
      }
      const spec = readAgentSpec(
        path.join(this.agentsRoot, fileName),
        agentsReal,
      );
      if (spec.name !== expectedName) {
        throw new Error(
          `Subagent name must match its filename: ${fileName}`,
        );
      }
      if (seen.has(spec.name)) {
        throw new Error(`Duplicate or reserved subagent name: ${spec.name}`);
      }
      seen.add(spec.name);
      return spec;
    });
  }
}

function readAgentSpec(filePath: string, agentsReal: string): SubagentSpec {
  const before = lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(
      `Subagent spec must be a regular file: ${path.basename(filePath)}`,
    );
  }
  if (before.size > MAX_SUBAGENT_SPEC_BYTES) {
    throw new Error(
      `Subagent spec exceeds ${MAX_SUBAGENT_SPEC_BYTES} bytes: ${path.basename(filePath)}`,
    );
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    const canonical = realpathSync(filePath);
    const canonicalInfo = statSync(canonical);
    assertPathWithin(
      agentsReal,
      canonical,
      `Subagent spec resolves outside its directory: ${path.basename(filePath)}`,
    );
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== canonicalInfo.dev ||
      opened.ino !== canonicalInfo.ino
    ) {
      throw new Error(
        `Subagent spec changed while it was being opened: ${path.basename(filePath)}`,
      );
    }

    const bytes = readBounded(descriptor, MAX_SUBAGENT_SPEC_BYTES);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        `Subagent spec must be valid UTF-8: ${path.basename(filePath)}`,
      );
    }

    let value: unknown;
    try {
      value = parse(source, {
        maxAliasCount: 0,
        uniqueKeys: true,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "invalid YAML";
      throw new Error(
        `Invalid subagent YAML ${path.basename(filePath)}: ${detail}`,
      );
    }
    const parsed = agentSpecSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `Invalid subagent spec ${path.basename(filePath)}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  } finally {
    closeSync(descriptor);
  }
}

function readBounded(descriptor: number, maxBytes: number): Uint8Array {
  const output = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < output.byteLength) {
    const read = readSync(
      descriptor,
      output,
      offset,
      output.byteLength - offset,
      null,
    );
    if (read === 0) {
      break;
    }
    offset += read;
  }
  if (offset > maxBytes) {
    throw new Error(`Subagent spec exceeds ${maxBytes} bytes.`);
  }
  return output.subarray(0, offset);
}

function assertPathWithin(root: string, target: string, message: string): void {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(message);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
