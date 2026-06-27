import type {
  HookEventName,
  HookHandler,
  HookResult,
} from "./types.js";
import {
  raceWithCancellation,
  throwIfCancelled,
} from "../agent/cancellation.js";

export class HookManager {
  private readonly hooks = new Map<HookEventName, HookHandler[]>();

  register(eventName: HookEventName, handler: HookHandler): void {
    const handlers = this.hooks.get(eventName) ?? [];
    handlers.push(handler);
    this.hooks.set(eventName, handlers);
  }

  has(eventName: HookEventName): boolean {
    return (this.hooks.get(eventName)?.length ?? 0) > 0;
  }

  async emit(
    eventName: HookEventName,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookResult | null> {
    for (const handler of this.hooks.get(eventName) ?? []) {
      throwIfCancelled(signal);
      const result = await raceWithCancellation(
        Promise.resolve(handler({ ...payload, signal })),
        signal,
      );

      if (result?.decision === "block") {
        return result;
      }
    }

    return null;
  }
}
