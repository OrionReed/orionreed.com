// Named event bus. Subscribe/emit synchronously; `until(name)` is an
// `Awaitable<T>` that wakes the next time `name` fires, carrying the
// emit data as the resume value.

import { awaitable, type Awaitable } from "./anim";

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

  /** Wake on the next emit of `name`; the emit data is the resume
   *  value. Pass an explicit type parameter (`bus.until<string>("msg")`)
   *  to type the payload at the call site. */
  until<T = unknown>(name: string): Awaitable<T> {
    return awaitable<T>((wake) => this.on(name, wake as (d: unknown) => void));
  }
}
