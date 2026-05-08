// Named event bus. Emit and subscribe by string key; signal-backed
// counters let observers react reactively, and an `Awaitable` lets
// generators wait for the next emit without polling.
//
// Layer-B utility: depends on signals + the Awaitable type. Independent
// of the Anim runtime — the bus has no opinion about scheduling, and
// Anim has no opinion about events. The runtime resumes a waiting
// generator synchronously when `emit` fires (zero latency), via the
// `Awaitable` protocol Anim consumes.

import { signal, type Signal, type ReadonlySignal } from "./signal";
import type { Awaitable } from "./anim";

/** Per-event reactive payload — count increments on each emit, `data`
 *  carries whatever was last emitted. */
export type EventState = { count: number; data: unknown };

export class EventBus {
  private signals = new Map<string, Signal<EventState>>();
  private handlers = new Map<string, Set<(data: unknown) => void>>();

  /** Fire a named event with optional data. Notifies callbacks and
   *  increments the named signal. Generators yielded on `until(name)`
   *  wake synchronously inside this call. */
  emit(name: string, data?: unknown): void {
    const sig = this.signals.get(name);
    if (sig) sig.value = { count: sig.peek().count + 1, data };
    const set = this.handlers.get(name);
    if (set) for (const fn of set) fn(data);
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

  /** Reactive signal that increments on each emit of `name`,
   *  carrying the latest payload. Lazy-created on first access. */
  onSignal(name: string): ReadonlySignal<EventState> {
    let sig = this.signals.get(name);
    if (!sig) {
      sig = signal({ count: 0, data: undefined });
      this.signals.set(name, sig);
    }
    return sig;
  }

  /** Awaitable that resumes on the next emit of `name`. */
  until(name: string): Awaitable {
    return (wake) => this.on(name, wake);
  }
}
