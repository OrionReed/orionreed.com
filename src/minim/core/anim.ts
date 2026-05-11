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

/** Spawn a generator parented to the suspended host. `onComplete` fires
 *  on natural completion only (not cancel). Only valid during the
 *  awaitable's initial subscribe call. */
export type SpawnFn = (gen: Animator, onComplete?: () => void) => () => void;

/** Subscribe + return a disposer. May call `wake` synchronously. For
 *  payload-less suspensions (the common case) use the default `void` —
 *  `wake` is then `() => void`. Typed-payload awaitables (`Awaitable<T>`)
 *  pass `value: T` through `wake`; the generator recovers it at the
 *  yield site:
 *
 *      const v = (yield aw) as unknown as T;
 *
 *  (TS has one `TNext` per generator — `number` for `dt` ergonomics —
 *  so per-yield-site narrowing is via cast. Wrap in a helper if it
 *  recurs: `function* take<T>(aw: Awaitable<T>) { return (yield aw)
 *  as unknown as T; }` then `yield* take(aw)`.) The optional `spawn`
 *  arg is for combinators that orchestrate child generators (`race`,
 *  `until`); simple subscribers ignore it. */
export type Awaitable<T = void> = (
  wake: [T] extends [void] ? () => void : (value: T) => void,
  spawn: SpawnFn,
) => () => void;

// `Awaitable<any>` in Yieldable is the variance escape: it accepts any
// `Awaitable<T>` and keeps the inline-lambda form (`yield (wake) => ...`)
// callable with zero args when the awaitable carries no payload.
export type Yieldable =
  | number
  | undefined
  | Animator
  | Yieldable[]
  | Awaitable<any>;
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
  private _clock = 0;
  private lastFrame = 0;
  /** Logical clock — total seconds advanced via `step(dt)`. For a
   *  reactive per-frame signal, use `clock(anim)` from `motion/clocks`. */
  get clock(): number {
    return this._clock;
  }
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

  /** Cancel everything. Safe from inside a running generator; reusable. */
  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.lastFrame = 0;
    this._clock = 0;
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

  /** Advance the runtime by an explicit dt. RAF in production; tests
   *  call directly. */
  step(dt: number): void {
    this._clock += dt;
    // Length-snapshot: children spawned during the loop wait for the
    // next tick (matches RAF semantics).
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const a = this.active[i];
      if (!a.alive) continue;
      if (a.wakeAt !== undefined) {
        if (this._clock >= a.wakeAt) {
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
      for (const l of this.listeners) {
        l.spawn?.(a.observeId, parent?.observeId, this._clock, gen);
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
      for (const l of this.listeners) l.cancel?.(a.observeId, this._clock);
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
    const dt =
      this.lastFrame === 0 ? 0 : Math.min(rafNow - this.lastFrame, 32) / 1000;
    this.lastFrame = rafNow;
    try {
      this.step(dt);
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

  /** Subscribe to an Awaitable. `spawn` is only valid during initial
   *  subscribe — calling it later throws. Sync-resolve safe. The
   *  payload `wake(value)` carries (or `undefined` for `Awaitable<void>`)
   *  is forwarded as the resume value to the generator. */
  private suspend(a: Active, awaitable: Awaitable<any>): void {
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
    a.wakeAt = this._clock + sec;
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
          this.suspend(a, v as Awaitable<any>);
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
      for (const l of this.listeners) l.complete?.(a.observeId, this._clock);
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
