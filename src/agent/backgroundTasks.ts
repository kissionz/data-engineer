import {
  BackgroundCommandManager,
  type BackgroundCommandSnapshot,
} from "../runtime/backgroundCommands.js";
import type { ShellExecutor } from "../runtime/shellExecutor.js";
import type { SessionStore } from "./session.js";
import type { BackgroundTaskStatusEvent } from "../protocol.js";

export function createSessionBackgroundTasks(
  executor: ShellExecutor | undefined,
  session: SessionStore,
): BackgroundCommandManager {
  return new BackgroundCommandManager(executor, async (snapshot) => {
    await session.append(toSessionEvent(snapshot));
  });
}

function toSessionEvent(
  snapshot: BackgroundCommandSnapshot,
): BackgroundTaskStatusEvent {
  return {
    type: "background_task_status",
    taskId: snapshot.taskId,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    exitCode: snapshot.exitCode,
    truncated: snapshot.outputTruncated,
    cleanupFailed: snapshot.cleanupFailed,
  };
}
