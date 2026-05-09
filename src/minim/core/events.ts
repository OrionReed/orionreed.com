// Named event bus. Emit and subscribe by string key; an `Awaitable` lets
// generators wait for the next emit without polling. For a reactive
// counter signal, wrap the subscription with `counter` from core.
//
// Layer-B utility: depends only on the Awaitable type. Independent of
// the Anim runtime — the bus has no opinion about scheduling, and Anim
// has no opinion about events. The runtime resumes a waiting generator
// synchronously when `emit` fires (zero latency), via the `Awaitable`
// protocol Anim consumes.

import type { Awaitable } from "./anim";

export class EventBus {
  private handlers = new Map<string, Set<(data: unknown) => void>>();

  /** Fire a named event with optional data. Notifies callbacks
   *  synchronously; generators yielded on `until(name)` wake inside
   *  this call. */
  emit(name: string, data?: unknown): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of set) fn(data);
  }

  /** Subscribe to a named event. Returns a disposer. */
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

  /** Awaitable that resumes on the next emit of `name`. */
  until(name: string): Awaitable {
    return (wake) => this.on(name, wake);
  }
}
