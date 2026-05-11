// Generator-driven animation runner.
//
// Yield contract:
//   undefined      → wait one frame, resume with `dt: number`.
//   number         → sleep N seconds; ≤0 is a tail-call (same frame).
//   Animator       → spawn as child, wait for completion.
//   Yieldable[]    → spawn N children in parallel, wait for all.
//   Awaitable<T>   → suspend until `wake(value: T)` fires; resume with `value`.
//
// Frame yields resume with `dt`; awaitable yields resume with their
// payload (cast at the yield site — TS has one TNext per generator).
// Sleep/parallel/child yields resume with `undefined`. A single RAF
// loop drives `step(dt)`; `step` is public for headless use.
//
// Time alteration is signal-arithmetic on `anim.timeScale` (1 = real,
// 0 = paused, 0.5 = slow-mo, -1 = reverse). `anim.clock` is the
// reactive logical-time signal; the frame loop writes to it at
// `wallDt × timeScale`.

import { signal, type ReadonlySignal } from "./signal";

/** Spawn a generator parented to the suspended host. `onComplete` fires
 *  on natural completion only (not cancel). Only valid during the
 *  awaitable's initial subscribe call. */
export type SpawnFn = (gen: Animator, onComplete?: () => void) => () => void;

/** Bare callable form of an awaitable: subscribe + return a disposer.
 *  May call `wake` synchronously. `Awaitable<T>` (below) is the public
 *  type — it adds `[Symbol.iterator]` so `yield* aw` returns the typed
 *  payload at the call site. `AwaitableFn<T>` is the low-level shape
 *  the runtime actually invokes; raw lambdas in yield position match
 *  this looser type. */
export type AwaitableFn<T = void> = (
  wake: [T] extends [void] ? () => void : (value: T) => void,
  spawn: SpawnFn,
) => () => void;

/** Subscribe + return a disposer, plus iterator sugar so the typed
 *  payload comes through at the yield site without a manual cast:
 *
 *      const evt = yield* untilClick(button);     // evt: MouseEvent
 *
 *  Constructed via the `awaitable<T>(impl)` factory; the iterator
 *  attaches at construction time. For payload-less suspensions, both
 *  `yield aw` (returns `number` per TNext, ignore it) and `yield* aw`
 *  (returns `void`) work; for typed payloads, prefer `yield*`. The
 *  optional `spawn` arg passed to `impl` is for combinators that
 *  orchestrate child generators (`race`, `until`); simple subscribers
 *  ignore it. */
export type Awaitable<T = void> = AwaitableFn<T> & {
  [Symbol.iterator](): Generator<Awaitable<T>, T, number>;
};

/** Wrap a bare awaitable impl as an `Awaitable<T>` with iterator sugar.
 *  Use at the definition site of any typed-payload suspension primitive:
 *
 *      function onceEvent(el: EventTarget, name: string): Awaitable<Event> {
 *        return awaitable<Event>((wake) => {
 *          const handler = (e: Event) => wake(e);
 *          el.addEventListener(name, handler, { once: true });
 *          return () => el.removeEventListener(name, handler);
 *        });
 *      }
 *
 *  Users then `const evt = yield* onceEvent(el, "click")` — typed
 *  payload, no cast. */
export function awaitable<T = void>(impl: AwaitableFn<T>): Awaitable<T> {
  const aw = impl as Awaitable<T>;
  aw[Symbol.iterator] = function* () {
    return (yield aw) as unknown as T;
  };
  return aw;
}

// `AwaitableFn<any>` in Yieldable is the variance escape: it accepts
// both raw lambdas (`(wake) => ...`) and factory-constructed iterable
// awaitables, and keeps inline lambdas callable with zero args.
export type Yieldable =
  | number
  | undefined
  | Animator
  | Yieldable[]
  | AwaitableFn<any>;
export type Animator = Generator<Yieldable, void, number>;

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

  /** Advance the runtime by an explicit dt. Bypasses `timeScale` —
   *  this is the raw "advance by exactly this much" primitive used by
   *  RAF (after applying `timeScale`) and tests. */
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
      // else: suspended on awaitable or spawned children (both park an
      // `awaitDispose`); resume is callback-driven.
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

  /** Mark dead, dispose pending Awaitable, cascade to children, then
   *  `.return()` (or defer if on the stack). Idempotent. `onComplete`
   *  is NOT fired on cancel. */
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
  // state. `suspend` below is the general path — subscribe to an
  // Awaitable, resume on `wake`. The other three (`suspendSleep`,
  // `suspendAll`, `suspendChild`) are inlined fast paths for the
  // sugar shapes — each could be expressed as an awaitable factory,
  // but they earn enough hot-path traffic to skip the closure
  // allocations and wire the wake-up directly.

  /** Subscribe to an awaitable (bare or iterable form). `spawn` is only
   *  valid during initial subscribe — calling it later throws. Sync-
   *  resolve safe. The payload `wake(value)` carries (or `undefined` for
   *  payload-less awaitables) is forwarded as the resume value. */
  private suspend(a: Active, awaitable: AwaitableFn<any>): void {
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
        throw new Error("minim: spawn() valid only during awaitable setup");
      }
      const child = this.spawn(gen, a, onComplete);
      return () => this.cancel(child);
    };
    dispose = awaitable(wake, spawn);
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
      // ergonomics; awaitable wakes pass through the payload as the
      // runtime's resume value. Yield sites that want a typed payload
      // recover it via `as T` at the call site.
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
          this.suspend(a, v as AwaitableFn<any>);
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
