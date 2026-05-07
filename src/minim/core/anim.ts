// Generator-driven animation runner. Yield contract:
//   undefined        → wait one frame, receive `dt` (seconds).
//   number           → pause that many seconds; receive `0`.
//                       (≤0 is an immediate tail-call.)
//   Animator         → spawn as child, wait for completion, receive `0`.
//   Yieldable[]      → spawn N children in parallel, wait for all, receive `0`.
//
// Synchronous scheduler: a single `requestAnimationFrame` loop steps every
// active generator per frame. No per-yield Promise allocation; the runtime
// owns the clock so sleeps are scheduled against it rather than via
// `setTimeout`. `step(dt)` advances by an explicit dt — used for headless /
// testing harnesses.

import { signal, type Signal, type ReadonlySignal } from "./signal";

export type Yieldable = number | undefined | Animator | Yieldable[];
export type Animator = Generator<Yieldable, void, number>;

/** Per-event reactive payload — count increments on each emit. */
export type EventState = { count: number; data: unknown };

/** Per-running-generator runtime state. Exactly one of `wakeAt` /
 *  `childrenLeft` is set while suspended; if neither is set, the active
 *  is "ready next frame" and will receive `dt` on resume. `alive` is the
 *  lazy-delete flag — `complete`/`stop` flip it false, `step` skips dead
 *  entries during iteration, and end-of-tick compaction removes them. */
interface Active {
  gen: Animator;
  wakeAt?: number;
  childrenLeft?: number;
  parent?: Active;
  alive: boolean;
}

export class Anim {
  private active: Active[] = [];
  private scopes = new Set<Anim>();
  private rafId = 0;
  private clock = 0;
  private lastFrame = 0;
  /** The generator currently in `gen.next()`. `stop()` defers cancelling
   *  it (calling `.return()` on a running generator throws TypeError);
   *  `advance`'s finally picks up the deferred return on unwind so its
   *  `try/finally` blocks still run. */
  private currentlyAdvancing: Active | undefined;
  private pendingReturn: Active | undefined;

  /** Event bus state — shared with parent via `scope()` so events
   *  flow freely between scopes within a diagram. */
  private eventSignals: Map<string, Signal<EventState>>;
  private eventHandlers: Map<string, Set<(data: unknown) => void>>;

  constructor(parent?: Anim) {
    if (parent) {
      this.eventSignals = parent.eventSignals;
      this.eventHandlers = parent.eventHandlers;
    } else {
      this.eventSignals = new Map();
      this.eventHandlers = new Map();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Run a generator forever, restarting on completion. */
  loop(genFn: () => Animator): void {
    const wrapped = (function* (): Animator {
      while (true) yield* genFn();
    })();
    this.spawn(wrapped);
  }

  /** Run an animator once. Accepts a generator directly or a no-arg factory. */
  run(arg: Animator | (() => Animator)): void {
    this.spawn(typeof arg === "function" ? arg() : arg);
  }

  /** Run `fn` every `sec` seconds. */
  every(sec: number, fn: () => void): void {
    this.loop(function* () {
      fn();
      yield sec;
    });
  }

  /** Periodic tick signal — increments every `sec` seconds. */
  pulse(sec: number): Signal<number> {
    const sig = signal(0);
    this.loop(function* () {
      yield sec;
      sig.value = sig.peek() + 1;
    });
    return sig;
  }

  /** Child Anim scoped to this one — stopped when the parent stops.
   *  Shares the parent's event bus. */
  scope(): Anim {
    const child = new Anim(this);
    this.scopes.add(child);
    return child;
  }

  /** Cancel pending operations. Safe to call from anywhere — including
   *  from within a running generator on this same Anim. Idempotent;
   *  cascades to scopes. The Anim is reusable after return.
   *
   *  Implementation: marks every active dead (`alive = false`) and runs
   *  its `gen.return()` so user `finally` blocks fire. Doesn't shrink
   *  `active.length` — that would invalidate `step`'s length-snapshot
   *  iteration if `stop` was called from inside a generator. The next
   *  `step` compacts the dead entries; if no further activity ever
   *  happens, the array is reclaimed when the Anim is GC'd. */
  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.lastFrame = 0;
    this.clock = 0;
    const toCancel = this.active.slice();
    for (const a of toCancel) {
      a.alive = false;
      if (a === this.currentlyAdvancing) {
        // Can't .return() a generator that's currently running.
        // `advance`'s finally picks this up after `gen.next` returns.
        this.pendingReturn = a;
        continue;
      }
      a.gen.return();
    }
    this.scopes.forEach((s) => s.stop());
    this.scopes.clear();
  }

  /** Advance the runtime by an explicit dt (seconds). Drives one tick
   *  of every active generator. Production calls this from RAF; tests /
   *  headless harnesses call it directly. */
  step(dt: number): void {
    this.clock += dt;
    // Length-snapshot iteration: items pushed past `len` during the loop
    // (newly spawned children) are deferred to the next tick — same
    // semantic as the browser's RAF callback list. Dead entries are
    // skipped here and reclaimed by the compaction pass below.
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const a = this.active[i];
      if (!a.alive) continue;
      if (a.wakeAt !== undefined) {
        if (this.clock >= a.wakeAt) {
          a.wakeAt = undefined;
          this.advance(a, 0);
        }
      } else if (a.childrenLeft !== undefined) {
        // Waiting on children; their completion drives `advance(a, 0)`.
      } else {
        this.advance(a, dt);
      }
    }
    // Compact dead entries in place. Bounded memory regardless of churn;
    // entries pushed past `len` during iteration are preserved.
    let w = 0;
    for (let r = 0; r < this.active.length; r++) {
      const a = this.active[r];
      if (a.alive) {
        if (r !== w) this.active[w] = a;
        w++;
      }
    }
    this.active.length = w;
  }

  // ── Event bus ───────────────────────────────────────────────────────

  /** Fire a named event with optional data. Notifies callbacks and
   *  increments the named signal. */
  emit(name: string, data?: unknown): void {
    const sig = this.eventSignals.get(name);
    if (sig) sig.value = { count: sig.peek().count + 1, data };
    const set = this.eventHandlers.get(name);
    if (set) for (const fn of set) fn(data);
  }

  /** Subscribe to a named event. Returns a disposer. */
  on(name: string, handler: (data: unknown) => void): () => void {
    let set = this.eventHandlers.get(name);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(name, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** Reactive signal that increments on each emit of `name`,
   *  carrying the latest payload. Lazy-created on first access. */
  onSignal(name: string): ReadonlySignal<EventState> {
    let sig = this.eventSignals.get(name);
    if (!sig) {
      sig = signal({ count: 0, data: undefined });
      this.eventSignals.set(name, sig);
    }
    return sig;
  }

  /** Generator that yields frames until the next emit of `name`. */
  *until(name: string): Animator {
    const sig = this.onSignal(name);
    const start = sig.peek().count;
    while (sig.value.count === start) yield;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private spawn(gen: Animator, parent?: Active): Active {
    const a: Active = { gen, parent, alive: true };
    this.active.push(a);
    this.advance(a, 0);
    this.kick();
    return a;
  }

  private kick(): void {
    if (this.rafId !== 0 || this.active.length === 0) return;
    // Re-entering after a quiet period: reset so the upcoming RAF reports
    // dt=0 — pauses don't accumulate logical time.
    if (performance.now() - this.lastFrame > 32) this.lastFrame = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (rafNow: number): void => {
    this.rafId = 0;
    // First frame after idle: dt=0. Subsequent frames: wall-clock interval,
    // clamped at 32ms for stutter recovery.
    const dt =
      this.lastFrame === 0 ? 0 : Math.min(rafNow - this.lastFrame, 32) / 1000;
    this.lastFrame = rafNow;
    try {
      this.step(dt);
    } finally {
      // Always reschedule, even if `step` propagated an unrecoverable
      // error — keeps the runtime alive.
      this.kick();
    }
  };

  private advance(a: Active, dt: number): void {
    this.currentlyAdvancing = a;
    try {
      let result = a.gen.next(dt);
      while (!result.done) {
        // `stop()` may have killed this active during gen.next.
        if (!a.alive) return;
        const v = result.value;
        if (typeof v === "number") {
          if (v > 0) {
            a.wakeAt = this.clock + v;
            return;
          }
          // ≤0: tail-call — advance immediately without consuming a frame.
          result = a.gen.next(0);
        } else if (v === undefined) {
          // Wait for next frame; receive dt then.
          return;
        } else if (Array.isArray(v)) {
          if (v.length === 0) {
            result = a.gen.next(0);
            continue;
          }
          a.childrenLeft = v.length;
          for (const item of v) {
            if (!a.alive) return;
            // Common case: item is a generator — spawn directly. Saves the
            // `function*() { yield* item }` wrapper layer.
            if (
              typeof item === "number" ||
              item === undefined ||
              Array.isArray(item)
            ) {
              this.spawn(wrapItem(item), a);
            } else {
              this.spawn(item, a);
            }
          }
          return;
        } else {
          // Single generator delegate via `yield gen`.
          a.childrenLeft = 1;
          this.spawn(v, a);
          return;
        }
      }
      this.complete(a);
    } catch (e) {
      // User-code error from `gen.next` — at spawn time or during step.
      // Treat as completion: log, drop from `active`, notify parent so
      // siblings/awaiters don't hang. The runtime stays alive.
      console.error("minim: animator threw", e);
      this.complete(a);
    } finally {
      this.currentlyAdvancing = undefined;
      // If `stop()` deferred this gen's return because it was currently
      // advancing, run it now — the gen is back in the suspended state.
      if (this.pendingReturn === a) {
        this.pendingReturn = undefined;
        a.gen.return();
      }
    }
  }

  private complete(a: Active): void {
    if (!a.alive) return;
    a.alive = false;
    const p = a.parent;
    if (!p || !p.alive || p.childrenLeft === undefined) return;
    p.childrenLeft -= 1;
    if (p.childrenLeft === 0) {
      p.childrenLeft = undefined;
      this.advance(p, 0);
    }
  }
}

/** One-yield generator for the rare parallel-array element that isn't
 *  itself a generator (number, undefined, nested array). Generators in
 *  arrays are spawned directly — no wrapper layer. */
function* wrapItem(v: number | undefined | Yieldable[]): Animator {
  yield v;
}
