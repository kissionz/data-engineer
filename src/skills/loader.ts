import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { Workspace } from "../runtime/workspace.js";

export const MAX_SKILL_SIZE_BYTES = 64 * 1024;
export const MAX_SKILL_COUNT = 128;
const MAX_SKILL_DIRECTORY_ENTRIES = 512;

export interface SkillMetadata {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface RecommendedSkill extends SkillSummary {
  score: number;
}

export interface LoadedSkill extends SkillSummary {
  metadata: SkillMetadata;
  content: string;
  path: string;
}

export type SkillLoaderErrorCode =
  | "invalid_name"
  | "not_found"
  | "invalid_path"
  | "invalid_file"
  | "too_large"
  | "invalid_frontmatter";

export class SkillLoaderError extends Error {
  constructor(
    message: string,
    readonly code: SkillLoaderErrorCode,
  ) {
    super(message);
    this.name = "SkillLoaderError";
  }
}

export class SkillLoader {
  private readonly workspaceRoot: string;
  private readonly skillsRoot: string;
  private cachedSummaries?: SkillSummary[];

  constructor(workspace: Workspace | string) {
    this.workspaceRoot = path.resolve(
      typeof workspace === "string" ? workspace : workspace.root,
    );
    this.skillsRoot = path.join(this.workspaceRoot, ".harness", "skills");
  }

  async list(): Promise<SkillSummary[]> {
    if (this.cachedSummaries) {
      return this.cachedSummaries.map((skill) => ({ ...skill }));
    }
    const root = await this.resolveSkillsRoot(true);

    if (!root) {
      this.cachedSummaries = [];
      return [];
    }

    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > MAX_SKILL_DIRECTORY_ENTRIES) {
      throw new SkillLoaderError(
        `Skills directory exceeds the ${MAX_SKILL_DIRECTORY_ENTRIES}-entry limit.`,
        "too_large",
      );
    }
    const names: string[] = [];

    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") {
        continue;
      }

      const entryPath = path.join(root, entry.name);
      const entryInfo = await stat(entryPath).catch(() => null);

      if (entryInfo?.isDirectory()) {
        names.push(entry.name);
      }
    }
    if (names.length > MAX_SKILL_COUNT) {
      throw new SkillLoaderError(
        `Skills directory exceeds the ${MAX_SKILL_COUNT}-skill limit.`,
        "too_large",
      );
    }

    const skills = await Promise.all(names.map((name) => this.load(name)));

    this.cachedSummaries = skills
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return this.cachedSummaries.map((skill) => ({ ...skill }));
  }

  async load(name: string): Promise<LoadedSkill> {
    assertValidSkillName(name);

    const root = await this.resolveSkillsRoot(false);
    const skillDirectory = path.join(root, name);
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const canonicalDirectory = await canonicalPath(skillDirectory, name);

    assertPathWithin(
      root,
      canonicalDirectory,
      `Skill path resolves outside the skills directory: ${name}`,
    );

    const directoryInfo = await stat(canonicalDirectory);

    if (!directoryInfo.isDirectory()) {
      throw new SkillLoaderError(`Skill is not a directory: ${name}`, "invalid_path");
    }

    const canonicalSkillPath = await canonicalPath(skillPath, name);

    assertPathWithin(
      canonicalDirectory,
      canonicalSkillPath,
      `SKILL.md resolves outside its skill directory: ${name}`,
    );

    const fileInfo = await stat(canonicalSkillPath);
    const linkInfo = await lstat(skillPath);

    if (!fileInfo.isFile() || linkInfo.isSymbolicLink()) {
      throw new SkillLoaderError(
        `SKILL.md must be a regular file: ${name}`,
        "invalid_file",
      );
    }

    if (fileInfo.size > MAX_SKILL_SIZE_BYTES) {
      throw new SkillLoaderError(
        `Skill exceeds the ${MAX_SKILL_SIZE_BYTES}-byte limit: ${name}`,
        "too_large",
      );
    }

    const bytes = await readFile(canonicalSkillPath);

    if (bytes.byteLength > MAX_SKILL_SIZE_BYTES) {
      throw new SkillLoaderError(
        `Skill exceeds the ${MAX_SKILL_SIZE_BYTES}-byte limit: ${name}`,
        "too_large",
      );
    }

    const { metadata, content } = parseSkillFile(bytes.toString("utf8"), name);

    if (metadata.name !== name) {
      throw invalidFrontmatter(
        name,
        `name must match the skill directory (${name})`,
      );
    }

    return {
      name: metadata.name,
      description: metadata.description,
      metadata,
      content,
      path: path.join(".harness", "skills", name, "SKILL.md"),
    };
  }

  async recommend(query: string, limit = 3): Promise<RecommendedSkill[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new SkillLoaderError(
        "Skill recommendation limit must be an integer between 1 and 10.",
        "invalid_name",
      );
    }
    const queryTokens = tokenizeForMatch(query);
    if (queryTokens.size === 0) {
      return [];
    }
    const summaries = await this.list();
    return summaries
      .map((skill) => ({
        name: skill.name,
        description: compactRecommendationDescription(skill.description),
        score: recommendationScore(query, queryTokens, skill),
      }))
      .filter((skill) => skill.score >= 2)
      .sort(
        (left, right) =>
          right.score - left.score || left.name.localeCompare(right.name),
      )
      .slice(0, limit);
  }

  private async resolveSkillsRoot(
    allowMissing: false,
  ): Promise<string>;
  private async resolveSkillsRoot(
    allowMissing: true,
  ): Promise<string | null>;
  private async resolveSkillsRoot(
    allowMissing: boolean,
  ): Promise<string | null> {
    const rootInfo = await stat(this.skillsRoot).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) {
        return null;
      }

      throw error;
    });

    if (!rootInfo) {
      if (allowMissing) {
        return null;
      }

      throw new SkillLoaderError(
        `Skills directory not found: ${this.skillsRoot}`,
        "not_found",
      );
    }

    if (!rootInfo.isDirectory()) {
      throw new SkillLoaderError(
        `Skills path is not a directory: ${this.skillsRoot}`,
        "invalid_path",
      );
    }

    const [workspaceRoot, skillsRoot] = await Promise.all([
      realpath(this.workspaceRoot),
      realpath(this.skillsRoot),
    ]);

    assertPathWithin(
      workspaceRoot,
      skillsRoot,
      "Skills directory resolves outside the workspace.",
    );

    return skillsRoot;
  }
}

function compactRecommendationDescription(value: string): string {
  const normalized = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= 300
    ? normalized
    : `${normalized.slice(0, 297)}...`;
}

function recommendationScore(
  rawQuery: string,
  queryTokens: ReadonlySet<string>,
  skill: SkillSummary,
): number {
  const normalizedQuery = rawQuery.toLocaleLowerCase();
  const normalizedName = skill.name.toLocaleLowerCase();
  let score = normalizedQuery.includes(normalizedName) ? 10 : 0;
  for (const token of tokenizeForMatch(skill.name.replaceAll(/[-_.]/g, " "))) {
    if (hasMatchingToken(queryTokens, token)) {
      score += 3;
    }
  }
  for (const token of tokenizeForMatch(skill.description)) {
    if (hasMatchingToken(queryTokens, token)) {
      score += 1;
    }
  }
  return score;
}

function tokenizeForMatch(value: string): Set<string> {
  const ignored = new Set([
    "and",
    "for",
    "from",
    "into",
    "the",
    "this",
    "that",
    "use",
    "with",
  ]);
  return new Set(
    value
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= 3 && !ignored.has(token)) ?? [],
  );
}

function hasMatchingToken(
  candidates: ReadonlySet<string>,
  target: string,
): boolean {
  for (const candidate of candidates) {
    if (
      candidate === target ||
      (candidate.length >= 5 &&
        target.length >= 5 &&
        (candidate.startsWith(target) || target.startsWith(candidate)))
    ) {
      return true;
    }
  }
  return false;
}

function assertValidSkillName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) {
    throw new SkillLoaderError(`Invalid skill name: ${String(name)}`, "invalid_name");
  }
}

async function canonicalPath(target: string, name: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new SkillLoaderError(`Skill not found: ${name}`, "not_found");
    }

    throw error;
  }
}

function assertPathWithin(root: string, target: string, message: string): void {
  const relative = path.relative(root, target);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SkillLoaderError(message, "invalid_path");
  }
}

function parseSkillFile(
  source: string,
  skillDirectoryName: string,
): { metadata: SkillMetadata; content: string } {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const lines = normalized.split(/\r?\n/);

  if (lines[0] !== "---") {
    throw invalidFrontmatter(skillDirectoryName, "missing opening delimiter");
  }

  const closingIndex = lines.indexOf("---", 1);

  if (closingIndex === -1) {
    throw invalidFrontmatter(skillDirectoryName, "missing closing delimiter");
  }

  let parsed: unknown;

  try {
    parsed = parse(lines.slice(1, closingIndex).join("\n"), {
      maxAliasCount: 10,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid YAML";
    throw invalidFrontmatter(skillDirectoryName, detail);
  }

  if (!isRecord(parsed)) {
    throw invalidFrontmatter(skillDirectoryName, "metadata must be a YAML mapping");
  }

  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    throw invalidFrontmatter(skillDirectoryName, "name must be a non-empty string");
  }

  if (
    typeof parsed.description !== "string" ||
    parsed.description.trim().length === 0
  ) {
    throw invalidFrontmatter(
      skillDirectoryName,
      "description must be a non-empty string",
    );
  }

  return {
    metadata: parsed as SkillMetadata,
    content: lines.slice(closingIndex + 1).join("\n"),
  };
}

function invalidFrontmatter(name: string, detail: string): SkillLoaderError {
  return new SkillLoaderError(
    `Invalid frontmatter for skill "${name}": ${detail}`,
    "invalid_frontmatter",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
