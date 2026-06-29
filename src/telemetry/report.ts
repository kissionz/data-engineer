import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isCanonicalTelemetryEvent } from "./sanitize.js";
import type {
  CancellationSource,
  TelemetryEvent,
  TelemetryOutcome,
} from "./types.js";

const DEFAULT_MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024 * 1024;

export interface TelemetryAggregateReport {
  schemaVersion: 1;
  eventCount: number;
  tasks: OutcomeAggregate & {
    started: number;
    finished: number;
    successRate: number | null;
  };
  models: OutcomeAggregate & {
    started: number;
    finished: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    estimatedCostUsd: number;
  };
  tools: OutcomeAggregate & {
    started: number;
    finished: number;
  };
  cancellations: {
    requested: number;
    finished: number;
    bySource: Record<CancellationSource, number>;
  };
}

interface OutcomeAggregate {
  succeeded: number;
  failed: number;
  cancelled: number;
  rejected: number;
}

interface StoredTelemetryEnvelope {
  schemaVersion: 1;
  eventId: string;
  timestamp: string;
  event: TelemetryEvent;
}

export async function readTelemetryReport(
  filePath: string,
  options: { maxBytes?: number } = {},
): Promise<TelemetryAggregateReport> {
  const maxBytes = boundedMaxBytes(options.maxBytes);
  const initial = await lstat(filePath);
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error("Telemetry report input must be a regular non-symlink file.");
  }
  if (initial.size > maxBytes) {
    throw new Error(`Telemetry report input exceeds ${maxBytes} bytes.`);
  }

  const handle = await open(
    filePath,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.dev !== initial.dev ||
      info.ino !== initial.ino ||
      info.size > maxBytes
    ) {
      throw new Error("Telemetry report input changed while being opened.");
    }
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        throw new Error("Telemetry report input changed while being read.");
      }
      offset += result.bytesRead;
    }
    const [finalPathInfo, finalHandleInfo] = await Promise.all([
      lstat(filePath),
      handle.stat(),
    ]);
    if (
      finalPathInfo.isSymbolicLink() ||
      finalPathInfo.dev !== info.dev ||
      finalPathInfo.ino !== info.ino ||
      finalHandleInfo.size !== info.size
    ) {
      throw new Error("Telemetry report input changed while being read.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (text.length > 0 && !text.endsWith("\n")) {
      throw new Error("Telemetry report input has an unterminated final record.");
    }
    const events = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => validateEnvelope(JSON.parse(line) as unknown).event);
    return aggregateTelemetry(events);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`Telemetry report input is not valid JSONL: ${error.message}`);
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export function aggregateTelemetry(
  events: readonly TelemetryEvent[],
): TelemetryAggregateReport {
  const tasks = { started: 0, finished: 0, ...emptyOutcomes() };
  const models = {
    started: 0,
    finished: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    ...emptyOutcomes(),
  };
  const tools = { started: 0, finished: 0, ...emptyOutcomes() };
  const bySource: Record<CancellationSource, number> = {
    user: 0,
    timeout: 0,
    system: 0,
    parent: 0,
  };
  let cancellationRequested = 0;
  let cancellationFinished = 0;

  for (const event of events) {
    if (event.type === "task_started") {
      tasks.started = safeAdd(tasks.started, 1);
    } else if (event.type === "task_finished") {
      tasks.finished = safeAdd(tasks.finished, 1);
      incrementOutcome(tasks, event.outcome);
    } else if (event.type === "model_request_started") {
      models.started = safeAdd(models.started, 1);
    } else if (event.type === "model_request_finished") {
      models.finished = safeAdd(models.finished, 1);
      incrementOutcome(models, event.outcome);
      models.inputTokens = safeAdd(models.inputTokens, event.inputTokens ?? 0);
      models.outputTokens = safeAdd(models.outputTokens, event.outputTokens ?? 0);
      models.cacheReadTokens = safeAdd(
        models.cacheReadTokens,
        event.cacheReadTokens ?? 0,
      );
      models.estimatedCostUsd = finiteAdd(
        models.estimatedCostUsd,
        event.estimatedCostUsd ?? 0,
      );
    } else if (event.type === "tool_started") {
      tools.started = safeAdd(tools.started, 1);
    } else if (event.type === "tool_finished") {
      tools.finished = safeAdd(tools.finished, 1);
      incrementOutcome(tools, event.outcome);
    } else if (event.type === "cancellation_requested") {
      cancellationRequested = safeAdd(cancellationRequested, 1);
      bySource[event.source] = safeAdd(bySource[event.source], 1);
    } else if (event.type === "cancellation_finished") {
      cancellationFinished = safeAdd(cancellationFinished, 1);
    }
  }

  return {
    schemaVersion: 1,
    eventCount: events.length,
    tasks: {
      ...tasks,
      successRate:
        tasks.finished === 0
          ? null
          : tasks.succeeded / tasks.finished,
    },
    models,
    tools,
    cancellations: {
      requested: cancellationRequested,
      finished: cancellationFinished,
      bySource,
    },
  };
}

function validateEnvelope(value: unknown): StoredTelemetryEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Telemetry envelope must be an object.");
  }
  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope);
  if (
    keys.length !== 4 ||
    !["schemaVersion", "eventId", "timestamp", "event"].every((key) =>
      Object.hasOwn(envelope, key),
    )
  ) {
    throw new Error("Telemetry envelope fields are invalid.");
  }
  if (envelope.schemaVersion !== 1) {
    throw new Error("Telemetry envelope schema version is invalid.");
  }
  if (
    typeof envelope.eventId !== "string" ||
    envelope.eventId.length > 200 ||
    !/^[A-Za-z0-9-]+$/.test(envelope.eventId)
  ) {
    throw new Error("Telemetry envelope event ID is invalid.");
  }
  if (
    typeof envelope.timestamp !== "string" ||
    !isCanonicalTimestamp(envelope.timestamp)
  ) {
    throw new Error("Telemetry envelope timestamp is invalid.");
  }
  if (!isCanonicalTelemetryEvent(envelope.event)) {
    throw new Error("Telemetry envelope event is not canonical.");
  }
  return envelope as unknown as StoredTelemetryEnvelope;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function emptyOutcomes(): OutcomeAggregate {
  return { succeeded: 0, failed: 0, cancelled: 0, rejected: 0 };
}

function incrementOutcome(
  aggregate: OutcomeAggregate,
  outcome: TelemetryOutcome,
): void {
  aggregate[outcome] = safeAdd(aggregate[outcome], 1);
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Telemetry aggregate exceeds the safe integer range.");
  }
  return total;
}

function finiteAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isFinite(total) || total < 0) {
    throw new Error("Telemetry cost aggregate is not finite.");
  }
  return total;
}

function boundedMaxBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_REPORT_BYTES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_REPORT_BYTES
  ) {
    throw new Error(
      `maxBytes must be an integer from 1 to ${MAX_REPORT_BYTES}.`,
    );
  }
  return resolved;
}
