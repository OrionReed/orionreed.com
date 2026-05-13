// Named event bus. Subscribe/emit synchronously; `until(name)` returns
// an `Animator<T>` that wakes the next time `name` fires, carrying the
// emit data as the resume value.

import { suspend, type Animator } from "@minim/core";

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

  /** Wake on the next emit of `name`; resume with the emit data. Pass
   *  an explicit type parameter (`yield* bus.until<string>("msg")`) to
   *  type the payload at the call site. */
  until<T = unknown>(name: string): Animator<T> {
    return suspend<T>((wake) => this.on(name, wake as (d: unknown) => void));
  }
}
