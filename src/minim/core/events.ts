// Named event bus. Subscribe/emit synchronously; `until(name)` is an
// Awaitable that wakes the next time `name` fires.

import type { Awaitable } from "./anim";

export class EventBus {
  private handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(name: string, data?: unknown): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of set) fn(data);
  }

  on(name: string, handler: (data: unknown) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  until(name: string): Awaitable {
    return (wake) => this.on(name, wake);
  }
}
