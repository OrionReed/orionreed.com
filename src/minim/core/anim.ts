// Generator-driven animation runner.
//
// Yield contract:
//   undefined         → wait one frame, resume with `dt: number`.
//   number            → sleep N seconds; ≤0 is a tail-call.
//   Animator<R>       → spawn as child, wait for completion.
//   [a, b, ...]       → spawn N children in parallel, wait for all.
//   yield* Animator<R>→ JS delegation; expression evaluates to `R`.
//
// Suspensions (events, signal changes, promises) are generator
// functions returning `Animator<T>`, built via `suspend<T>(impl)`;
// `yield* suspend(...)` returns `T`. Advanced/internal: the runtime
// also accepts a bare `(wake, spawn?) => dispose` in yield position —
// the impl shape that `suspend<T>()` wraps. Useful for custom
// combinators (see `core/suspensions.ts:race`).
//
// `anim.timeScale` is a writable signal (`1` real-time, `0` paused,
// `0.5` slow-mo, `-1` reverse for integrators). `anim.clock` is the
// reactive logical-time signal — `step(dt)` and `next(dt)` both write
// `dt × timeScale`. `Anim` satisfies the Animator protocol, so yield*
// a sub-Anim to compose runtimes and scope time independently.

import { signal, type ReadonlySignal } from "./signal";

// Cap any single frame's dt to this many ms. RAF normally delivers
// 16-17 ms (60 Hz) down to ~8 ms (120 Hz). The clamp matters for tab
// backgrounding (browsers throttle RAF to ~1 Hz when the tab is
// hidden, then resume with the accumulated wall-time delta), heavy
// frames that overrun, and the after-idle reset path. 32 ms is high
// enough to not trigger on a single dropped frame, low enough that
// one step doesn't jump multiple frames of integration.
const FRAME_CAP_MS = 32;

/** Spawn a generator parented to the suspended host. `onComplete`
 *  fires on natural completion only (not cancel), receiving the
 *  generator's `return`-value (the `R` in `Animator<R>`). Only valid
 *  during the suspension's initial subscribe call. */
export type SpawnFn = <R>(
  gen: Animator<R>,
  onComplete?: (value: R) => void,
) => () => void;

// Bare subscribe-and-return-disposer shape. The runtime invokes this
// directly when a generator yields a function; the `suspend()` factory
// yields one inside a one-shot generator so `yield* suspend(...)`
// returns the typed payload.
type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (value: T) => void,
  spawn: SpawnFn,
) => () => void;

/** Construct a one-shot suspension generator. `wake(value)` resumes
 *  the host with `value`, which becomes the result of `yield*
 *  suspend(impl)`. The optional `spawn` arg is for combinators that
 *  orchestrate child generators; simple subscribers ignore it.
 *
 *      function* untilEvent(el, name): Animator<Event> {
 *        return yield* suspend<Event>((wake) => {
 *          const h = (e: Event) => wake(e);
 *          el.addEventListener(name, h, { once: true });
 *          return () => el.removeEventListener(name, h);
 *        });
 *      }
 */
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

// Internal. Includes `SuspendFn<any>` so raw lambdas (`(wake) => ...`)
// also yield correctly without needing the factory wrapping.
export type Yieldable =
  | number
  | undefined
  | Animator<any>
  | Yieldable[]
  | SuspendFn<any>;
/** A generator the runtime can advance. `R` is what `yield* anim`
 *  evaluates to; defaults to `void`. */
export type Animator<R = void> = Generator<Yieldable, R, number>;

type ObserveListeners = {
  spawn?: (
    id: number,
    parentId: number | undefined,
    clock: number,
    gen: Animator<any>,
  ) => void;
  complete?: (id: number, clock: number) => void;
  cancel?: (id: number, clock: number) => void;
};

// Active state — single int field. Cheap to store, cheap to dispatch
// on, and the lifecycle is self-describing.
const READY = 0;        // ran a frame yield (`yield;`); advance on next step
const SLEEPING = 1;     // yielded N>0; wake when clock ≥ wakeAt
const SUBSCRIBED = 2;   // yielded a suspend-fn; wake via dispose callback
const WAITING = 3;      // yielded gen/array; resume when child(ren) complete
const DEAD = 4;         // cancelled or completed; skipped by step

interface Active {
  gen: Animator<any>;
  state: number;                          // one of the constants above
  wakeAt: number;                         // valid when state === SLEEPING
  dispose: (() => void) | undefined;      // valid when state === SUBSCRIBED
  // Parent's "child finished" callback. Called with the gen's
  // `return`-value on natural completion; not called on cancel.
  onComplete: ((value: unknown) => void) | undefined;
  parent: Active | undefined;
  // True while inside `advance`; defers `.return()` if cancelled re-entrantly.
  onStack: boolean;
  pendingReturn: boolean;
  observeId: number | undefined;
}

export const isGen = (v: unknown): v is Animator<any> =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Animator<any>).next === "function";

/** Lift any `Yieldable` to an `Animator`. Generators pass through. */
export function asGen(v: Yieldable): Animator<any> {
  if (isGen(v)) return v;
  return (function* () {
    yield v;
  })();
}

export class Anim {
  private active: Active[] = [];
  private rafId = 0;
  private _clock = signal(0);
  private lastFrame = 0;
  /** Logical-time signal. Advanced by every `step(dt)` at
   *  `dt × timeScale`. Read-only. */
  readonly clock: ReadonlySignal<number> = this._clock;
  /** Time-flow rate. `1` real-time, `0` paused, `0.5` slow-mo,
   *  `-1` reverse (integrators only). Applied inside `step(dt)`. */
  readonly timeScale = signal(1);
  private listeners = new Set<ObserveListeners>();
  private nextActiveId = 0;

  // ── Public API ──────────────────────────────────────────────────────

  /** Run a generator forever, restarting on completion. */
  loop(factory: () => Animator): () => void {
    return this.run(function* () {
      while (true) yield* factory();
    });
  }

  /** Run a generator once. Returns a disposer that cancels it. */
  run(arg: Animator | (() => Animator)): () => void {
    const gen = typeof arg === "function" ? arg() : arg;
    const a = this.spawn(gen);
    return () => this.cancel(a);
  }

  /** Cancel everything; reset `_clock` to 0. Leaves `timeScale`. */
  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.lastFrame = 0;
    this._clock.value = 0;
    for (const a of this.active.slice()) this.cancel(a);
  }

  /** Subscribe to lifecycle events. Only listed fields fire; already-
   *  running generators are not retroactively included. */
  observe(listeners: ObserveListeners): () => void {
    this.listeners.add(listeners);
    return () => {
      this.listeners.delete(listeners);
    };
  }

  // ── Animator protocol ───────────────────────────────────────────────
  //
  // Anim satisfies Iterator<Yieldable, void, number> — yield* a
  // sub-Anim into a parent gen to compose runtimes, give it its own
  // timeScale to scope time, and cancellation cascades through the
  // gen tree.

  next(dt?: number): IteratorResult<Yieldable, void> {
    this.step(dt ?? 0);
    return { done: false, value: undefined };
  }
  return(): IteratorResult<Yieldable, void> {
    this.stop();
    return { done: true, value: undefined };
  }
  throw(e: unknown): IteratorResult<Yieldable, void> {
    this.stop();
    throw e;
  }
  [Symbol.iterator](): this {
    return this;
  }

  /** Advance by `dt × timeScale`. Single advance primitive — RAF,
   *  tests, and `next(dt)` all funnel here. No-op when paused. */
  step(dt: number): void {
    const scale = this.timeScale.peek();
    if (scale === 0) return;
    const scaled = dt * scale;
    const clock = (this._clock.value += scaled);
    // Length-snapshot iteration: children spawned during the loop
    // wait for the next tick (matches RAF semantics).
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const a = this.active[i];
      const s = a.state;
      if (s === READY) {
        this.advance(a, scaled);
      } else if (s === SLEEPING && clock >= a.wakeAt) {
        a.state = READY;
        this.advance(a, undefined);
      }
      // SUBSCRIBED, WAITING, DEAD: skip.
    }
    // Compact dead entries; new entries past `len` survive.
    let w = 0;
    for (let r = 0; r < this.active.length; r++) {
      const a = this.active[r];
      if (a.state !== DEAD) {
        if (r !== w) this.active[w] = a;
        w++;
      }
    }
    this.active.length = w;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private spawn(
    gen: Animator<any>,
    parent?: Active,
    onComplete?: (value: unknown) => void,
  ): Active {
    const a: Active = {
      gen,
      state: READY,
      wakeAt: 0,
      dispose: undefined,
      onComplete,
      parent,
      onStack: false,
      pendingReturn: false,
      observeId: undefined,
    };
    this.active.push(a);
    if (this.listeners.size > 0) {
      a.observeId = ++this.nextActiveId;
      const t = this._clock.peek();
      for (const l of this.listeners) {
        l.spawn?.(a.observeId, parent?.observeId, t, gen);
      }
    }
    // First .next() arg is discarded by JS generators.
    this.advance(a, undefined);
    this.kick();
    return a;
  }

  /** Idempotent. `onComplete` is NOT fired on cancel. */
  private cancel(a: Active): void {
    if (a.state === DEAD) return;
    const wasSubscribed = a.state === SUBSCRIBED;
    a.state = DEAD;
    if (this.listeners.size > 0 && a.observeId !== undefined) {
      const t = this._clock.peek();
      for (const l of this.listeners) l.cancel?.(a.observeId, t);
    }
    if (wasSubscribed) {
      // SUBSCRIBED ⇒ dispose set (atomic with state, no JS interleaving).
      const d = a.dispose!;
      a.dispose = undefined;
      d();
    }
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const child = this.active[i];
      if (child.parent === a && child.state !== DEAD) this.cancel(child);
    }
    if (a.onStack) {
      a.pendingReturn = true;
      return;
    }
    a.gen.return(undefined);
  }

  private kick(): void {
    if (this.rafId !== 0 || this.active.length === 0) return;
    // After idle, reset so the next RAF sees dt=0.
    if (performance.now() - this.lastFrame > FRAME_CAP_MS) this.lastFrame = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (rafNow: number): void => {
    this.rafId = 0;
    try {
      const dt =
        this.lastFrame === 0
          ? 0
          : Math.min(rafNow - this.lastFrame, FRAME_CAP_MS) / 1000;
      // Paused: hold lastFrame at 0 so unpause computes dt=0.
      this.lastFrame = this.timeScale.peek() === 0 ? 0 : rafNow;
      this.step(dt);
    } finally {
      this.kick();
    }
  };

  // ── Suspension ──────────────────────────────────────────────────────
  //
  // `subscribe` handles the general SuspendFn path (callback-driven
  // wake). The three fast paths (`suspendSleep/All/Child`) aren't just
  // perf — they need direct runtime state (_clock for sleeps, parent
  // linkage for child cascade) that the public `suspend<T>()` factory
  // can't reach. Expressing them in userland would require exposing
  // those internals or breaking semantics (e.g. setTimeout-based
  // sleeps would ignore `timeScale`).

  /** `spawn` is only valid during the initial subscribe — calling
   *  later throws. Sync-resolve safe. `wake(value)` forwards `value`
   *  as the resume of the generator that yielded the impl. */
  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    let setupActive = true;
    const wake = (value?: unknown) => {
      if (resumed || a.state === DEAD) return;
      resumed = true;
      const d = a.dispose;
      a.state = READY;
      a.dispose = undefined;
      if (d) d();          // undefined during sync-resolve (dispose not yet stored)
      this.advance(a, value);
    };
    const spawn: SpawnFn = <R>(
      gen: Animator<R>,
      onComplete?: (value: R) => void,
    ) => {
      if (!setupActive) {
        throw new Error("minim: spawn() valid only during suspend setup");
      }
      // Internal `spawn` types onComplete as `(unknown) => void` — the
      // runtime passes whatever `result.value` was; we trust the caller
      // to know the gen's R.
      const child = this.spawn(
        gen,
        a,
        onComplete as ((value: unknown) => void) | undefined,
      );
      return () => this.cancel(child);
    };
    const dispose = impl(wake, spawn);
    setupActive = false;
    if (resumed || a.state === DEAD) {
      dispose();           // sync-resolve: dispose was never stored on `a`
    } else {
      a.state = SUBSCRIBED;
      a.dispose = dispose;
    }
  }

  private suspendSleep(a: Active, sec: number): void {
    a.state = SLEEPING;
    a.wakeAt = this._clock.peek() + sec;
  }

  /** Spawn each child; resume when all complete. Cancel cascade
   *  reaches them via `parent === a`. */
  private suspendAll(a: Active, children: Yieldable[]): void {
    if (children.length === 0) {
      this.advance(a, undefined);
      return;
    }
    let left = children.length;
    a.state = WAITING;
    const onChild = () => {
      if (--left === 0 && a.state === WAITING) {
        a.state = READY;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < children.length; j++) {
      if (a.state === DEAD) return;     // re-entrant cancel during spawn
      this.spawn(asGen(children[j]), a, onChild);
    }
  }

  private suspendChild(a: Active, gen: Animator<any>): void {
    a.state = WAITING;
    this.spawn(gen, a, () => {
      if (a.state === WAITING) {
        a.state = READY;
        this.advance(a, undefined);
      }
    });
  }

  private advance(a: Active, resume: unknown): void {
    a.onStack = true;
    try {
      // TNext is widened to `number` for frame-yield ergonomics;
      // suspension wakes forward their payload here, and the
      // `suspend<T>()` factory makes it the typed return.
      let result = a.gen.next(resume as number);
      while (!result.done) {
        if (a.state === DEAD) return;
        const v = result.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) {
            this.suspendSleep(a, v);
            return;
          }
          result = a.gen.next(0);
          continue;
        }
        if (Array.isArray(v)) {
          this.suspendAll(a, v);
          return;
        }
        if (typeof v === "function") {
          this.subscribe(a, v as SuspendFn<any>);
          return;
        }
        this.suspendChild(a, v as Animator<any>);
        return;
      }
      // Natural completion: `result.value` is the generator's
      // return-value (the `R` in `Animator<R>`). Pass to onComplete
      // so combinators can collect typed payloads from child gens.
      this.complete(a, result.value);
    } catch (e) {
      // Isolate user errors: log, complete with no value, keep the
      // runtime alive.
      console.error("minim: animator threw", e);
      this.complete(a, undefined);
    } finally {
      a.onStack = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        a.gen.return(undefined);
      }
    }
  }

  // State is always READY at complete entry (every advance entry has
  // state=READY; advance either dispatches a yield via suspend* and
  // returns, or finishes and reaches here). No SUBSCRIBED-dispose
  // cleanup needed.
  private complete(a: Active, value: unknown): void {
    if (a.state === DEAD) return;
    a.state = DEAD;
    if (this.listeners.size > 0 && a.observeId !== undefined) {
      const t = this._clock.peek();
      for (const l of this.listeners) l.complete?.(a.observeId, t);
    }
    if (a.onComplete) {
      const cb = a.onComplete;
      a.onComplete = undefined;
      cb(value);
    }
  }
}
