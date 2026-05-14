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
// Time scoping: every spawn() accepts an optional `scale`
// (`number | () => number`). The active's `dt` becomes `dtRaw ×
// effectiveScale` where `effectiveScale = parent.effectiveScale ×
// ownScale`. `.at(scale)` (in `core/chain.ts`) is the public surface;
// the runtime just plumbs scale through `spawn()`. There is no global
// `timeScale`.
//
// Anim has no Signal dependency. Time is exposed as a plain number
// (`clockMs`) and a callback-shaped subscription (`onClock(cb)`). For
// a `Signal<number>` view, see the `clockSignal(anim)` adapter in the
// signals layer.

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
 *  generator's `return`-value (the `R` in `Animator<R>`). Optional
 *  `scale` scopes time: `number` for static, `() => number` for
 *  reactive (read each frame). Only valid during the suspension's
 *  initial subscribe call. */
export type SpawnFn = <R>(
  gen: Animator<R>,
  onComplete?: (value: R) => void,
  scale?: number | (() => number),
) => () => void;

// Bare subscribe-and-return-disposer shape. The runtime invokes this
// directly when a generator yields a function; the `suspend()` factory
// yields one inside a one-shot generator so `yield* suspend(...)`
// returns the typed payload.
export type SuspendFn<T = void> = (
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

/** Project a `Yieldable` to "what does `yield* this` evaluate to".
 *  Generators carry it in `R`; typed `SuspendFn<R>` (from `suspend<R>()`)
 *  carries it via the wake signature; everything else (number, array,
 *  bare suspend-fn, `undefined`) is `void`. */
export type PayloadOf<Y> =
  Y extends Animator<infer R> ? R
  : Y extends SuspendFn<infer R> ? R
  : void;

/** Lifecycle observer hooks — single optional slot per kind. The
 *  trace/assert layer sets these to record spawns/completes/cancels;
 *  the runtime cares only about whether each hook is undefined.
 *  See `assert/spans.ts` for the consumer. */
export interface AnimObserver {
  spawn?(
    id: number,
    parentId: number | undefined,
    clock: number,
    gen: Animator<any>,
  ): void;
  complete?(id: number, clock: number): void;
  cancel?(id: number, clock: number): void;
}

// Active state — single int field. Cheap to store, cheap to dispatch
// on, and the lifecycle is self-describing.
const READY = 0; // ran a frame yield (`yield;`); advance on next step
const SLEEPING = 1; // yielded N>0; wake when own clock ≥ wakeAt
const SUBSCRIBED = 2; // yielded a suspend-fn; wake via dispose callback
const WAITING = 3; // yielded gen/array; resume when child(ren) complete
const DEAD = 4; // cancelled or completed; skipped by step

/** One running generator. Class (not interface) so the shape is
 *  monomorphic — JIT-friendly hot path. */
class Active {
  state: number = READY;
  wakeAt: number = 0; // in own scaled clock
  dispose: (() => void) | undefined = undefined;
  // Parent's "child finished" callback. Called with the gen's
  // `return`-value on natural completion; not called on cancel.
  onComplete: ((value: unknown) => void) | undefined = undefined;
  // True while inside `advance`; defers `.return()` if cancelled re-entrantly.
  onStack: boolean = false;
  pendingReturn: boolean = false;
  observeId: number | undefined = undefined;

  // ── Per-Active time scoping ─────────────────────────────────────
  // `scale` is either a static `number` or a thunk `() => number`
  // (read each step). `effectiveScale = parent.effectiveScale × resolved`
  // is cached and refreshed once per step in spawn order — parents
  // before children, so the parent's eff is up-to-date by the time
  // any child reads it.
  scale: number | (() => number) = 1;
  effectiveScale: number = 1;
  clock: number = 0; // per-Active scaled time

  constructor(
    readonly gen: Animator<any>,
    readonly parent: Active | undefined,
  ) {}
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
  // Single ordered array. Spawn order matters: parents before
  // children, so the per-step eff-scale walk reads up-to-date parent
  // values in one linear pass. (A future refactor could partition by
  // state to skip parked actives in advance — but the state branch is
  // well-predicted and the gain is small versus the bookkeeping cost.)
  private active: Active[] = [];
  private rafId = 0;
  private _clockMs = 0;
  private lastFrame = 0;
  private clockListeners: Set<(t: number) => void> | undefined;
  private nextActiveId = 0;

  /** Lifecycle observer — single optional slot. Set by the trace
   *  layer (`assert/spans.ts`). Multiple subscribers compose via a
   *  fan-out wrapper in user code; the runtime sees one. */
  observer: AnimObserver | undefined = undefined;

  // ── Public API ──────────────────────────────────────────────────────

  /** Current root-level elapsed time, in seconds. Plain number — no
   *  Signal dependency. For a `Signal<number>` view that ticks each
   *  step, use `clockSignal(anim)` from the signals adapter. */
  get clockMs(): number {
    return this._clockMs;
  }

  /** Subscribe to per-step clock updates. Fired after each `step()`
   *  with the new `clockMs`. Returns a disposer. */
  onClock(cb: (t: number) => void): () => void {
    if (!this.clockListeners) this.clockListeners = new Set();
    this.clockListeners.add(cb);
    const ls = this.clockListeners;
    return () => {
      ls.delete(cb);
    };
  }

  /** Run a generator once. Returns a disposer that cancels it.
   *  Accepts any return-type — `Animator<R>` for any `R` — because
   *  top-level callers don't care about the return value. */
  run(arg: Animator<any> | (() => Animator<any>)): () => void {
    const gen = typeof arg === "function" ? arg() : arg;
    const a = this.spawn(gen);
    return () => this.cancel(a);
  }

  /** Cancel everything; reset clock to 0. */
  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.lastFrame = 0;
    this._clockMs = 0;
    for (const a of this.active.slice()) this.cancel(a);
  }

  /** Advance by `dt` (seconds). Single advance primitive — RAF,
   *  tests, and external drivers funnel here.
   *
   *  Scale handling: walk active[] in spawn order, refreshing each
   *  active's `effectiveScale` from `parent.effectiveScale × own` and
   *  scaling that active's `dt`. Because parents appear before
   *  children in the array, the parent's eff is always current. */
  step(dt: number): void {
    if (dt > 0) {
      this._clockMs += dt;
      if (this.clockListeners) {
        for (const cb of this.clockListeners) cb(this._clockMs);
      }
    }
    // Length-snapshot iteration: children spawned during the loop
    // wait for the next tick (matches RAF semantics).
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const a = this.active[i];
      if (a.state === DEAD) continue;

      // Refresh effective scale. Parents come first → up-to-date.
      const own = typeof a.scale === "number" ? a.scale : a.scale();
      a.effectiveScale = (a.parent ? a.parent.effectiveScale : 1) * own;
      const scaled = dt * a.effectiveScale;
      a.clock += scaled;

      const s = a.state;
      if (s === READY) {
        this.advance(a, scaled);
      } else if (s === SLEEPING && a.clock >= a.wakeAt) {
        a.state = READY;
        this.advance(a, undefined);
      }
      // SUBSCRIBED / WAITING: skip the advance — their effectiveScale
      // has been refreshed so any descendants see the right parent.
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
    scale?: number | (() => number),
  ): Active {
    const a = new Active(gen, parent);
    a.onComplete = onComplete;
    if (scale !== undefined) a.scale = scale;
    // Initial eff: parent's eff × resolved own.
    const own = typeof a.scale === "number" ? a.scale : a.scale();
    a.effectiveScale = (parent ? parent.effectiveScale : 1) * own;

    this.active.push(a);
    if (this.observer?.spawn) {
      a.observeId = ++this.nextActiveId;
      this.observer.spawn(a.observeId, parent?.observeId, this._clockMs, gen);
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
    if (this.observer?.cancel && a.observeId !== undefined) {
      this.observer.cancel(a.observeId, this._clockMs);
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
      this.lastFrame = rafNow;
      this.step(dt);
    } finally {
      this.kick();
    }
  };

  // ── Suspension ──────────────────────────────────────────────────────
  //
  // `subscribe` handles the general SuspendFn path (callback-driven
  // wake). The three fast paths (`suspendSleep/All/Child`) aren't just
  // perf — they need direct runtime state (clock for sleeps, parent
  // linkage for child cascade) that the public `suspend<T>()` factory
  // can't reach. Expressing them in userland would require exposing
  // those internals or breaking semantics (e.g. setTimeout-based
  // sleeps would ignore per-Active scale).

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
      if (d) d(); // undefined during sync-resolve (dispose not yet stored)
      this.advance(a, value);
    };
    const spawn: SpawnFn = <R>(
      gen: Animator<R>,
      onComplete?: (value: R) => void,
      scale?: number | (() => number),
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
        scale,
      );
      return () => this.cancel(child);
    };
    const dispose = impl(wake, spawn);
    setupActive = false;
    if (resumed || a.state === DEAD) {
      dispose(); // sync-resolve: dispose was never stored on `a`
    } else {
      a.state = SUBSCRIBED;
      a.dispose = dispose;
    }
  }

  private suspendSleep(a: Active, sec: number): void {
    a.state = SLEEPING;
    a.wakeAt = a.clock + sec;
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
      if (a.state === DEAD) return; // re-entrant cancel during spawn
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
    if (this.observer?.complete && a.observeId !== undefined) {
      this.observer.complete(a.observeId, this._clockMs);
    }
    if (a.onComplete) {
      const cb = a.onComplete;
      a.onComplete = undefined;
      cb(value);
    }
  }
}
