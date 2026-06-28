export type MemoryScope = "project" | "user";

export type MemoryKind =
  | "instruction"
  | "preference"
  | "project_fact"
  | "workflow"
  | "warning";

export type MemoryStatus = "active" | "superseded" | "deleted";

export interface MemorySource {
  type: "user" | "manifest" | "tool_result" | "agent";
  sessionId?: string;
  eventId?: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  confidence: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  status: MemoryStatus;
}

export interface MemorySearchQuery {
  text?: string;
  scopes?: MemoryScope[];
  kinds?: MemoryKind[];
  tags?: string[];
  limit?: number;
}

export interface MemoryWriteInput {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  confidence: number;
  tags: string[];
  expiresAt?: string;
  supersedesId?: string;
}

export interface MemoryWriteResult {
  record: MemoryRecord;
  deduplicated: boolean;
}

export class MemoryValidationError extends Error {
  readonly code = "invalid_memory";

  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

export class MemoryConflictError extends Error {
  readonly code = "memory_conflict";

  constructor(
    message: string,
    readonly conflictingIds: string[],
  ) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

export class MemorySecurityError extends Error {
  readonly code = "unsafe_memory";

  constructor(message: string) {
    super(message);
    this.name = "MemorySecurityError";
  }
}
