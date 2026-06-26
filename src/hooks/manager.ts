import type {
  HookEventName,
  HookHandler,
  HookResult,
} from "./types.js";

export class HookManager {
  private readonly hooks = new Map<HookEventName, HookHandler[]>();

  register(eventName: HookEventName, handler: HookHandler): void {
    const handlers = this.hooks.get(eventName) ?? [];
    handlers.push(handler);
    this.hooks.set(eventName, handlers);
  }

  async emit(
    eventName: HookEventName,
    payload: Record<string, unknown>,
  ): Promise<HookResult | null> {
    for (const handler of this.hooks.get(eventName) ?? []) {
      const result = await handler(payload);

      if (result?.decision === "block") {
        return result;
      }
    }

    return null;
  }
}
