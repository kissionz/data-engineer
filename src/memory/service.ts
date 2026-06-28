import { randomUUID } from "node:crypto";
import { MemoryStore, withMemoryTransaction } from "./store.js";
import {
  MemoryConflictError,
  MemorySecurityError,
  MemoryValidationError,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchQuery,
  type MemoryWriteInput,
  type MemoryWriteResult,
} from "./types.js";

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|passwd|secret|cookie)\b\s*(?:is|=|:)\s*\S{6,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const INJECTION_PATTERNS = [
  /\bignore (?:all |any |the )?(?:previous|prior|above) instructions?\b/i,
  /\b(?:override|disregard|forget) (?:the )?(?:system|developer|previous|prior) (?:prompt|message|instructions?)\b/i,
  /\breveal (?:the )?(?:system|developer) (?:prompt|message|instructions?)\b/i,
  /\b(?:jailbreak|developer mode|prompt injection)\b/i,
  /\bact as (?:the )?(?:system|developer|administrator)\b/i,
];

export class MemoryService {
  private readonly stores: Record<MemoryScope, MemoryStore>;
  private readonly transactionPath: string;

  constructor(paths: { project: string; user: string }) {
    this.stores = {
      project: new MemoryStore(paths.project, "project"),
      user: new MemoryStore(paths.user, "user"),
    };
    this.transactionPath = `${paths.user}.transaction`;
  }

  async search(query: MemorySearchQuery): Promise<MemoryRecord[]> {
    const limit = normalizeLimit(query.limit);
    const scopes = normalizeScopes(query.scopes);
    const kinds = normalizeKinds(query.kinds);
    const requestedTags = normalizeTags(query.tags ?? []);
    const terms = tokenize(query.text ?? "");
    const records = (
      await Promise.all(scopes.map((scope) => this.stores[scope].listActive()))
    ).flat();

    return records
      .filter((record) => !kinds || kinds.includes(record.kind))
      .map((record) => ({
        record,
        score: scoreRecord(record, terms, requestedTags),
      }))
      .filter(({ score }) => score >= 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.record.confidence - left.record.confidence ||
          Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt) ||
          left.record.id.localeCompare(right.record.id),
      )
      .slice(0, limit)
      .map(({ record }) => record);
  }

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    return withMemoryTransaction(this.transactionPath, () =>
      this.writeLocked(input),
    );
  }

  private async writeLocked(
    input: MemoryWriteInput,
  ): Promise<MemoryWriteResult> {
    if (input.source.type !== "user") {
      throw new MemorySecurityError(
        "Long-term memory writes require an explicit user source.",
      );
    }
    assertSafeContent(input.content);
    const scope = normalizeScope(input.scope);
    const tags = normalizeTags(input.tags);
    const content = normalizeContent(input.content);
    const active = await this.stores[scope].listActive();
    const otherScope: MemoryScope = scope === "project" ? "user" : "project";
    const otherActive = await this.stores[otherScope].listActive();
    const duplicate = active.find(
      (record) => normalizeFact(record.content) === normalizeFact(content),
    );
    const now = new Date().toISOString();

    if (duplicate) {
      const updated: MemoryRecord = {
        ...duplicate,
        source: input.source,
        confidence: Math.max(duplicate.confidence, normalizeConfidence(input.confidence)),
        tags: [...new Set([...duplicate.tags, ...tags])].sort(),
        updatedAt: now,
        ...(input.expiresAt
          ? { expiresAt: normalizeFutureExpiry(input.expiresAt) }
          : {}),
      };
      await this.stores[scope].upsert(updated);
      return { record: updated, deduplicated: true };
    }

    const conflicts = findConflicts(
      [...active, ...otherActive],
      input.kind,
      tags,
      content,
    );
    if (conflicts.length > 0 && !input.supersedesId) {
      throw new MemoryConflictError(
        "A different active memory has the same kind and tag subject. Ask the user whether it should be replaced.",
        conflicts.map((record) => record.id),
      );
    }

    let superseded: MemoryRecord | undefined;
    if (input.supersedesId) {
      superseded = active.find((record) => record.id === input.supersedesId);
      if (!superseded) {
        throw new MemoryConflictError(
          "The memory selected for replacement is not active in this scope.",
          [input.supersedesId],
        );
      }
      if (
        conflicts.length > 0 &&
        conflicts.some(
          (record) =>
            record.id !== superseded?.id || record.scope !== superseded?.scope,
        )
      ) {
        throw new MemoryConflictError(
          "Replacing this memory would leave another conflicting active fact.",
          conflicts
            .filter(
              (record) =>
                record.id !== superseded?.id ||
                record.scope !== superseded?.scope,
            )
            .map((record) => record.id),
        );
      }
    }

    const record: MemoryRecord = {
      id: randomUUID(),
      scope,
      kind: normalizeKind(input.kind),
      content,
      source: input.source,
      confidence: normalizeConfidence(input.confidence),
      tags,
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt
        ? { expiresAt: normalizeFutureExpiry(input.expiresAt) }
        : {}),
      status: "active",
    };

    if (superseded) {
      await this.stores[scope].supersede(superseded.id, record);
    } else {
      await this.stores[scope].upsert(record);
    }
    return { record, deduplicated: false };
  }

  async delete(scope: MemoryScope, id: string, reason: string): Promise<void> {
    return withMemoryTransaction(this.transactionPath, () =>
      this.deleteLocked(scope, id, reason),
    );
  }

  private async deleteLocked(
    scope: MemoryScope,
    id: string,
    reason: string,
  ): Promise<void> {
    const normalizedScope = normalizeScope(scope);
    assertSafeContent(reason);
    const existing = (await this.stores[normalizedScope].listActive()).find(
      (record) => record.id === id,
    );
    if (!existing) {
      throw new MemoryConflictError(
        "Memory is not active or does not exist in this scope.",
        [id],
      );
    }
    await this.stores[normalizedScope].delete(id, reason);
  }

  async list(scope: MemoryScope): Promise<MemoryRecord[]> {
    return this.stores[normalizeScope(scope)].list();
  }
}

function scoreRecord(
  record: MemoryRecord,
  terms: string[],
  requestedTags: string[],
): number {
  const contentTerms = new Set(tokenize(record.content));
  const tags = new Set(record.tags);
  const termMatches = terms.filter(
    (term) => contentTerms.has(term) || record.content.toLowerCase().includes(term),
  ).length;
  const tagMatches = requestedTags.filter((tag) => tags.has(tag)).length;
  if (
    (terms.length > 0 && termMatches === 0) ||
    (requestedTags.length > 0 && tagMatches === 0)
  ) {
    return -1;
  }
  const ageDays = Math.max(
    0,
    (Date.now() - Date.parse(record.updatedAt)) / 86_400_000,
  );
  return (
    termMatches * 4 +
    tagMatches * 6 +
    record.confidence * 2 +
    1 / (1 + ageDays / 30)
  );
}

function findConflicts(
  records: MemoryRecord[],
  kind: MemoryKind,
  tags: string[],
  content: string,
): MemoryRecord[] {
  if (tags.length === 0) {
    return [];
  }
  const tagKey = [...tags].sort().join("\0");
  return records.filter(
    (record) =>
      record.kind === kind &&
      [...record.tags].sort().join("\0") === tagKey &&
      normalizeFact(record.content) !== normalizeFact(content),
  );
}

function assertSafeContent(content: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new MemorySecurityError(
      "Memory content appears to contain a secret or credential.",
    );
  }
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new MemorySecurityError(
      "Memory content appears to contain prompt-injection instructions.",
    );
  }
}

function normalizeFact(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeFact(value);
  const hanBigrams = [...normalized.matchAll(/\p{Script=Han}+/gu)].flatMap(
    ([sequence]) => {
      const characters = [...sequence];
      return Array.from(
        { length: Math.max(0, characters.length - 1) },
        (_, index) => characters.slice(index, index + 2).join(""),
      );
    },
  );
  return [
    ...new Set(
      normalized
        .split(/\s+/u)
        .filter((term) => term.length > 1)
        .concat(hanBigrams),
    ),
  ];
}

function normalizeContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new MemoryValidationError("content must be a string.");
  }
  const content = value.trim();
  if (!content || content.length > 4_000 || content.includes("\0")) {
    throw new MemoryValidationError(
      "content must contain between 1 and 4000 safe characters.",
    );
  }
  return content;
}

function normalizeScope(value: unknown): MemoryScope {
  if (value !== "project" && value !== "user") {
    throw new MemoryValidationError("scope must be project or user.");
  }
  return value;
}

function normalizeScopes(value: unknown): MemoryScope[] {
  if (value === undefined) {
    return ["project", "user"];
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new MemoryValidationError("scopes must contain project and/or user.");
  }
  return [...new Set(value.map(normalizeScope))];
}

function normalizeKind(value: unknown): MemoryKind {
  const kinds: MemoryKind[] = [
    "instruction",
    "preference",
    "project_fact",
    "workflow",
    "warning",
  ];
  if (!kinds.includes(value as MemoryKind)) {
    throw new MemoryValidationError("kind is invalid.");
  }
  return value as MemoryKind;
}

function normalizeKinds(value: unknown): MemoryKind[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
    throw new MemoryValidationError("kinds must be a non-empty array.");
  }
  return [...new Set(value.map(normalizeKind))];
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new MemoryValidationError("tags must contain at most 20 strings.");
  }
  const tags = value.map((tag) => {
    if (typeof tag !== "string") {
      throw new MemoryValidationError("Each tag must be a string.");
    }
    const normalized = tag.trim().toLowerCase();
    if (!normalized || normalized.length > 64 || normalized.includes("\0")) {
      throw new MemoryValidationError("Each tag must contain 1 to 64 characters.");
    }
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(normalized)) {
      throw new MemoryValidationError(
        "Tags may contain only letters, numbers, dot, underscore, colon, and hyphen.",
      );
    }
    assertSafeContent(normalized);
    return normalized;
  });
  return [...new Set(tags)].sort();
}

function normalizeConfidence(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new MemoryValidationError("confidence must be between 0 and 1.");
  }
  return value;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) {
    return 10;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new MemoryValidationError("limit must be a positive integer.");
  }
  return Math.min(value as number, 10);
}

function normalizeFutureExpiry(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new MemoryValidationError("expiresAt must be an ISO timestamp.");
  }
  if (Date.parse(value) <= Date.now()) {
    throw new MemoryValidationError("expiresAt must be in the future.");
  }
  return value;
}
