// Minimal reactive primitives — `Signal<T>` (writable), `computed(fn)`,
// `effect(fn)`, plus the prototype's headline addition: `[Symbol.iterator]`
// on the Reactive class so signals are first-class Yieldables.
//
// Implementation is hand-rolled (not alien-signals) to keep the file
// readable. Push-propagation, batched flush via microtask, dedupe by
// `Object.is`. Behaviorally compatible with prod for the surface
// exercised in the tests; this file is NOT a prod implementation.

import { type Suspend } from "./engine";

// ─── Internal subscriber state ──────────────────────────────────────

type Subscriber = {
  fn: () => void;
  /** Signals this subscriber currently reads. Re-tracked on each run. */
  deps: Set<Signal<unknown>>;
  /** Cleanup callback returned by the subscriber's last run, if any. */
  cleanup?: () => void;
  /** Per-run epoch — used to drop stale propagations after re-track. */
  epoch: number;
  active: boolean;
};

let activeSub: Subscriber | undefined;
let batchDepth = 0;
const queued = new Set<Subscriber>();

// ─── Public types ───────────────────────────────────────────────────

export type Equals<T> = (a: T, b: T) => boolean;

export interface SignalOptions<T> {
  equals?: Equals<T>;
}

export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

export type Val<T> = T | (() => T) | Read<T>;

export const value = <T>(v: Val<T>): T => {
  if (v instanceof Signal) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
};

// ─── The Reactive class ─────────────────────────────────────────────

export class Signal<T = unknown> implements Read<T> {
  /** @internal */ subs = new Set<Subscriber>();
  private current: T;
  private getter?: () => T;
  private cached?: T;
  private hasCache = false;
  private dirty = true;
  /** Stable synth subscriber for tracking deps in computed mode.
   *  Reused across recomputes so dep.subs.delete(this.synth) works. */
  private synth?: Subscriber;
  private equals: Equals<T>;

  constructor(initial: T, opts?: SignalOptions<T>) {
    this.current = initial;
    this.equals = opts?.equals ?? Object.is;
  }

  /** @internal */ static makeComputed<T>(fn: () => T): Signal<T> {
    const s = new Signal<T>(undefined as T);
    s.getter = fn;
    s.synth = {
      fn: () => s.invalidate(),
      deps: new Set(),
      epoch: 0,
      active: true,
    };
    return s;
  }

  get value(): T {
    if (this.getter) {
      if (this.dirty) this.recompute();
      if (activeSub) {
        this.subs.add(activeSub);
        activeSub.deps.add(this as Signal<unknown>);
      }
      return this.cached as T;
    }
    if (activeSub) {
      this.subs.add(activeSub);
      activeSub.deps.add(this as Signal<unknown>);
    }
    return this.current;
  }

  set value(next: T) {
    if (this.getter) throw new TypeError("Cannot write to a computed signal");
    if (this.equals(this.current, next)) return;
    this.current = next;
    this.notifySubs();
  }

  peek(): T {
    if (this.getter) {
      if (this.dirty) this.recompute();
      return this.cached as T;
    }
    return this.current;
  }

  private recompute(): void {
    const synth = this.synth!;
    // Detach old deps using stable synth identity.
    for (const dep of synth.deps) dep.subs.delete(synth);
    synth.deps.clear();

    const prev = activeSub;
    activeSub = synth;
    try {
      const next = (this.getter as () => T)();
      const wasCached = this.hasCache;
      const prevCached = this.cached;
      this.cached = next;
      this.hasCache = true;
      this.dirty = false;
      // Only propagate if value actually changed (and we had a previous).
      if (wasCached && !this.equals(prevCached as T, next)) this.notifySubs();
    } finally {
      activeSub = prev;
    }
  }

  /** @internal */ invalidate(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.notifySubs();
    }
  }

  /** @internal */ notifySubs(): void {
    for (const s of this.subs) {
      if (!s.active) continue;
      queued.add(s);
    }
    if (batchDepth === 0) flush();
  }
}

// ─── Public factories ───────────────────────────────────────────────

export const signal = <T>(initial: T, opts?: SignalOptions<T>): Signal<T> =>
  new Signal(initial, opts);

export const computed = <T>(fn: () => T): Signal<T> => Signal.makeComputed(fn);

/** "Always non-equal" signal: every write fires propagation, even if the
 *  new value would normally compare equal. The natural fit for events
 *  encoded as signals — every emit is one wake. */
export const pulse = <T>(initial: T): Signal<T> =>
  new Signal(initial, { equals: () => false });

export const effect = (fn: () => void | (() => void)): (() => void) => {
  const sub: Subscriber = {
    fn: () => run(),
    deps: new Set(),
    epoch: 0,
    active: true,
  };
  const run = (): void => {
    if (!sub.active) return;
    if (sub.cleanup) {
      const c = sub.cleanup;
      sub.cleanup = undefined;
      try {
        c();
      } catch (e) {
        console.error(e);
      }
    }
    // Re-track from scratch.
    for (const dep of sub.deps) dep.subs.delete(sub);
    sub.deps.clear();
    const prev = activeSub;
    activeSub = sub;
    try {
      const ret = fn();
      if (typeof ret === "function") sub.cleanup = ret;
    } finally {
      activeSub = prev;
    }
  };
  run();
  return () => {
    if (!sub.active) return;
    sub.active = false;
    if (sub.cleanup) {
      try {
        sub.cleanup();
      } catch (e) {
        console.error(e);
      }
      sub.cleanup = undefined;
    }
    for (const dep of sub.deps) dep.subs.delete(sub);
    sub.deps.clear();
  };
};

export const batch = <R>(fn: () => R): R => {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
};

function flush(): void {
  while (queued.size > 0) {
    const snap = [...queued];
    queued.clear();
    for (const s of snap) if (s.active) s.fn();
  }
}

// ─── The headline addition: `[Symbol.iterator]` for change-wait ─────
//
// Pauses the calling generator until this signal next propagates a
// non-equal value (per its own `equals`), then resumes with the new
// value. Composes with `race`, `all`, `play().until` since signals are
// now Yieldables — no special branches in the engine.
//
// For "wait until truthy, immediately if already true," use `when(sig)`.
// For "wait until predicate," derive a signal: `yield* computed(() => p(sig.value))`
// and pair with `when()`.

(Signal.prototype as any)[Symbol.iterator] = function* <T>(
  this: Signal<T>,
): Generator<Suspend<T>, T, T> {
  return yield (wake) => {
    let primed = false;
    return effect(() => {
      const v = this.value; // tracks
      if (!primed) {
        primed = true;
        return;
      }
      wake(v);
    });
  };
};

// Expose the iterator type so the `Signal` class is structurally a
// Yieldable. The class IS already iterable at runtime; the type
// declaration here ensures TS sees `yield* sig` as a valid Animator.
declare module "./signal" {
  interface Signal<T> {
    [Symbol.iterator](): Generator<Suspend<T>, T, T>;
  }
}
