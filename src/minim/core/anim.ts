// Generator-driven animation runner.
//
// Yield contract (user-facing):
//   undefined      → wait one frame, resume with `dt: number`.
//   number         → sleep N seconds; ≤0 is a tail-call (same frame).
//   Animator<R>    → spawn as child, wait for completion.
//   Yieldable[]    → spawn N children in parallel, wait for all.
//   yield* Animator<R> → JS delegation; expression evaluates to `R`.
//
// Frame yields resume with `dt`. Sleep/parallel/child yields resume
// with `undefined`. Suspensions (external events, signal changes,
// promises) are generator functions returning `Animator<T>`, built via
// the `suspend<T>(impl)` factory; `yield* suspend(...)` returns `T`.
//
// Time alteration is signal-arithmetic on `anim.timeScale` (1 = real,
// 0 = paused, 0.5 = slow-mo, -1 = reverse). `anim.clock` is the
// reactive logical-time signal; the frame loop writes to it at
// `wallDt × timeScale`. `Anim` itself satisfies the Animator protocol
// (`next`/`return`/`throw`/`Symbol.iterator`) — yield* a sub-Anim
// inside another generator to compose runtimes / scope time.

import { signal, type ReadonlySignal } from "./signal";

/** Spawn a generator parented to the suspended host. `onComplete` fires
 *  on natural completion only (not cancel). Only valid during the
 *  suspension's initial subscribe call. */
export type SpawnFn = (gen: Animator, onComplete?: () => void) => () => void;

// Internal: the bare callable shape the runtime actually invokes for
// `function`-shaped Yieldables. Raw lambdas in yield position match
// this; the `suspend()` factory yields one inside a generator.
type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (value: T) => void,
  spawn: SpawnFn,
) => () => void;

/** Construct a one-shot suspension generator. The `impl` is the
 *  classic subscribe-and-return-disposer protocol; `wake(value)`
 *  resumes the host with `value`, which becomes the result of
 *  `yield* suspend(impl)`. The optional `spawn` arg is for combinators
 *  that orchestrate child generators (`race`, `until`); simple
 *  subscribers ignore it. For payload-less suspensions, omit `T` —
 *  `wake` is then `() => void`.
 *
 *      function onceEvent(el, name): Animator<Event> {
 *        return suspend<Event>((wake) => {
 *          const h = (e: Event) => wake(e);
 *          el.addEventListener(name, h, { once: true });
 *          return () => el.removeEventListener(name, h);
 *        });
 *      }
 *      // user: const evt = yield* onceEvent(el, "click");
 */
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

// Yieldable union — internal. The `SuspendFn<any>` member admits both
// raw lambdas (`(wake) => ...`) and the impl yielded by `suspend`.
export type Yieldable =
  | number
  | undefined
  | Animator<any>
  | Yieldable[]
  | SuspendFn<any>;
/** A generator the runtime can advance. `R` is what `yield* anim`
 *  evaluates to; defaults to `void` for the common case. */
export type Animator<R = void> = Generator<Yieldable, R, number>;

// Lifecycle listeners for `Anim.observe`. Local type — Anim stays
// self-contained and we don't export listener-shape internals.
type ObserveListeners = {
  spawn?: (
    id: number,
    parentId: number | undefined,
    clock: number,
    gen: Animator,
  ) => void;
  complete?: (id: number, clock: number) => void;
  cancel?: (id: number, clock: number) => void;
};

interface Active {
  gen: Animator;
  wakeAt: number | undefined;
  awaitDispose: (() => void) | undefined;
  onComplete: (() => void) | undefined;
  parent: Active | undefined;
  alive: boolean;
  // True while inside `advance`; defers `.return()` if cancelled re-entrantly.
  onStack: boolean;
  pendingReturn: boolean;
  observeId: number | undefined;
}

export const isGen = (v: unknown): v is Animator =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Animator).next === "function";

/** Lift any `Yieldable` to an `Animator`. Generators pass through. */
export function asGen(v: Yieldable): Animator {
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
  /** Reactive logical-time signal. Advanced by the frame loop at
   *  `wallDt × timeScale`, or by direct `step(dt)` calls (which bypass
   *  `timeScale`). Read-only — write through `step()` or by mutating
   *  `timeScale`. */
  readonly clock: ReadonlySignal<number> = this._clock;
  /** Time-flow rate. `1` is real-time, `0` is paused, `0.5` is slow-mo,
   *  `2` is fast-forward, negative reverses (integrator behaviors only).
   *  Multiplies wall-clock dt at the frame-loop boundary; `step(dt)`
   *  bypasses, applying dt directly for manual / headless advance. */
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

  /** Run a generator once. Accepts a factory or an Animator. Returns a
   *  disposer that cancels it. */
  run(arg: Animator | (() => Animator)): () => void {
    const gen = typeof arg === "function" ? arg() : arg;
    const a = this.spawn(gen);
    return () => this.cancel(a);
  }

  /** Cancel everything. Safe from inside a running generator; reusable.
   *  Does not reset `timeScale` — that's user state. */
  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.lastFrame = 0;
    this._clock.value = 0;
    for (const a of this.active.slice()) this.cancel(a);
  }

  /** Subscribe to lifecycle events. Only listed fields fire; already-
   *  running generators are not retroactively included. Returns a
   *  disposer. */
  observe(listeners: ObserveListeners): () => void {
    this.listeners.add(listeners);
    return () => {
      this.listeners.delete(listeners);
    };
  }

  // ── Animator protocol — Anim *is* an Animator ──────────────────────
  //
  // Implementing the iterator protocol means Anim itself can be
  // yielded into a parent generator (`yield* sub`), driven by tests
  // (`anim.next(dt)`), or cancelled like any other generator
  // (`anim.return()`). Sub-Anims compose for free — give them their
  // own timeScale to scope time, run them as children of a parent
  // Anim, and cancellation cascades through the gen tree.

  /** Advance the runtime by `dt`, applying `timeScale`. Per the
   *  Animator protocol — called by the parent's `yield*` or by a
   *  test harness. */
  next(dt?: number): IteratorResult<Yieldable, void> {
    const scale = this.timeScale.peek();
    if (scale !== 0) this.step((dt ?? 0) * scale);
    return { done: false, value: undefined };
  }
  /** Stop the runtime (cancel all actives). Idempotent; runtime is
   *  reusable after. Per the Animator protocol — called when a
   *  parent's `yield*` unwinds. */
  return(): IteratorResult<Yieldable, void> {
    this.stop();
    return { done: true, value: undefined };
  }
  /** Stop the runtime and propagate the error. Per the Animator
   *  protocol — called when a parent gen throws into us. */
  throw(e: unknown): IteratorResult<Yieldable, void> {
    this.stop();
    throw e;
  }
  [Symbol.iterator](): this {
    return this;
  }

  /** Advance the runtime by an explicit dt. Bypasses `timeScale` —
   *  this is the raw "advance by exactly this much" primitive used by
   *  RAF (after applying `timeScale`) and tests. For Animator-protocol
   *  advance that honours `timeScale`, use `next(dt)`. */
  step(dt: number): void {
    this._clock.value += dt;
    // Length-snapshot: children spawned during the loop wait for the
    // next tick (matches RAF semantics).
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const a = this.active[i];
      if (!a.alive) continue;
      if (a.wakeAt !== undefined) {
        if (this._clock.peek() >= a.wakeAt) {
          a.wakeAt = undefined;
          this.advance(a, undefined);
        }
      } else if (a.awaitDispose === undefined) {
        this.advance(a, dt);
      }
      // else: suspended on a subscription or spawned children (both
      // park an `awaitDispose`); resume is callback-driven.
    }
    // Compact dead entries; entries pushed past `len` survive.
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

  // ── Internals ───────────────────────────────────────────────────────

  private spawn(
    gen: Animator,
    parent?: Active,
    onComplete?: () => void,
  ): Active {
    const a: Active = {
      gen,
      wakeAt: undefined,
      awaitDispose: undefined,
      onComplete,
      parent,
      alive: true,
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
    // First `.next()` arg is discarded by JS generators; pass undefined.
    this.advance(a, undefined);
    this.kick();
    return a;
  }

  /** Mark dead, dispose any pending subscription, cascade to children,
   *  then `.return()` (or defer if on the stack). Idempotent.
   *  `onComplete` is NOT fired on cancel. */
  private cancel(a: Active): void {
    if (!a.alive) return;
    a.alive = false;
    if (this.listeners.size > 0 && a.observeId !== undefined) {
      const t = this._clock.peek();
      for (const l of this.listeners) l.cancel?.(a.observeId, t);
    }
    if (a.awaitDispose) {
      const d = a.awaitDispose;
      a.awaitDispose = undefined;
      d();
    }
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const child = this.active[i];
      if (child.parent === a && child.alive) this.cancel(child);
    }
    if (a.onStack) {
      a.pendingReturn = true;
      return;
    }
    a.gen.return();
  }

  private kick(): void {
    if (this.rafId !== 0 || this.active.length === 0) return;
    // After idle, force the next RAF's dt to 0 so pauses don't
    // accumulate logical time.
    if (performance.now() - this.lastFrame > 32) this.lastFrame = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (rafNow: number): void => {
    this.rafId = 0;
    try {
      const scale = this.timeScale.peek();
      if (scale === 0) {
        // Paused — don't step, and reset lastFrame so unpausing
        // starts with dt=0 (no catch-up hitch).
        this.lastFrame = 0;
      } else {
        const dt =
          this.lastFrame === 0 ? 0 : Math.min(rafNow - this.lastFrame, 32) / 1000;
        this.lastFrame = rafNow;
        this.step(dt * scale);
      }
    } finally {
      this.kick();
    }
  };

  // ── Suspension ──────────────────────────────────────────────────────
  //
  // Every yield ultimately parks the active in a "suspended until X"
  // state. `subscribe` below is the general path — subscribe to a
  // SuspendFn impl, resume on `wake`. The other three (`suspendSleep`,
  // `suspendAll`, `suspendChild`) are inlined fast paths for the sugar
  // shapes — each could be expressed via the suspend factory, but they
  // earn enough hot-path traffic to skip the closure allocations and
  // wire the wake-up directly.

  /** Subscribe to a suspend-fn impl. `spawn` is only valid during the
   *  initial subscribe — calling it later throws. Sync-resolve safe.
   *  `wake(value)`'s payload (or `undefined`) is forwarded as the
   *  resume value of the generator that yielded the impl. */
  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    let dispose: (() => void) | undefined;
    let setupActive = true;
    const wake = (value?: unknown) => {
      if (resumed || !a.alive) return;
      resumed = true;
      const d = dispose;
      if (d) {
        if (a.awaitDispose === d) a.awaitDispose = undefined;
        d();
      }
      this.advance(a, value);
    };
    const spawn: SpawnFn = (gen, onComplete) => {
      if (!setupActive) {
        throw new Error("minim: spawn() valid only during suspend setup");
      }
      const child = this.spawn(gen, a, onComplete);
      return () => this.cancel(child);
    };
    dispose = impl(wake, spawn);
    setupActive = false;
    if (resumed || !a.alive) dispose();
    else a.awaitDispose = dispose;
  }

  /** Fast path for `yield <sec>`: park on the wakeAt clock slot. */
  private suspendSleep(a: Active, sec: number): void {
    a.wakeAt = this._clock.peek() + sec;
  }

  /** Fast path for `yield [a, b, ...]`: spawn each as a child, resume
   *  when all complete. `noop` parks the host as "suspended on children"
   *  (step() skips it); cancel cascade still reaches them via parent==a. */
  private suspendAll(a: Active, children: Yieldable[]): void {
    if (children.length === 0) {
      this.advance(a, undefined);
      return;
    }
    let left = children.length;
    a.awaitDispose = noop;
    const onChild = () => {
      if (--left === 0 && a.alive) {
        a.awaitDispose = undefined;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < children.length; j++) {
      if (!a.alive) return;
      this.spawn(asGen(children[j]), a, onChild);
    }
  }

  /** Fast path for `yield <gen>`: spawn as a single child, resume on
   *  its natural completion. */
  private suspendChild(a: Active, gen: Animator): void {
    a.awaitDispose = noop;
    this.spawn(gen, a, () => {
      if (a.alive) {
        a.awaitDispose = undefined;
        this.advance(a, undefined);
      }
    });
  }

  private advance(a: Active, resume: unknown): void {
    a.onStack = true;
    try {
      // Cast: TNext is widened to `number` for the common frame-yield
      // ergonomics; suspension wakes pass through their payload as the
      // runtime's resume value. The `suspend<T>()` factory wraps this
      // so `yield* suspend(impl)` returns the typed payload naturally.
      let result = a.gen.next(resume as number);
      while (!result.done) {
        if (!a.alive) return;
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
        this.suspendChild(a, v as Animator);
        return;
      }
      this.complete(a);
    } catch (e) {
      // Isolate user-code errors: log, complete (notifies parent),
      // keep the runtime alive.
      console.error("minim: animator threw", e);
      this.complete(a);
    } finally {
      a.onStack = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        a.gen.return();
      }
    }
  }

  private complete(a: Active): void {
    if (!a.alive) return;
    a.alive = false;
    if (this.listeners.size > 0 && a.observeId !== undefined) {
      const t = this._clock.peek();
      for (const l of this.listeners) l.complete?.(a.observeId, t);
    }
    if (a.awaitDispose) {
      const d = a.awaitDispose;
      a.awaitDispose = undefined;
      d();
    }
    if (a.onComplete) {
      const cb = a.onComplete;
      a.onComplete = undefined;
      cb();
    }
  }
}

// Sentinel `awaitDispose` marking "suspended on own spawned children."
const noop = (): void => {};
