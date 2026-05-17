// Generator-driven cooperative animation runtime.
//
// Yield contract:
//   undefined        park 1 frame; resume with dt
//   number > 0       sleep N seconds; resume with dt of waking step
//   Animator         spawn child; resume with R when it completes
//   Yieldable[]      parallel-all; resume with results[] when all done
//   SuspendFn        callback wake; resume with wake's value
//   PromiseLike<T>   await; resume with resolved value (or throw on reject)
//
// Cancel via `gen.return()` (silent; runs `try/finally`).
// Errors propagate via `gen.throw()` to the parent's yield site
// (model-a: thrown children, rejected promises, and `wake.throw(e)`
// all raise at the parent's `yield` rather than going to a side channel).
//
// SuspendFn ctx: a narrow `(clock, onFrame, run)` surface — engine
// internals (step, stop) are not exposed. Prod composers' three-arg
// form `(wake, spawn, anim) => dispose` is supported via arity dispatch.

const DEAD = -Infinity;
const READY = 0;
const PARKED = Infinity;

export type Yieldable =
  | undefined
  | number
  | Animator<any>
  | readonly Yieldable[]
  | SuspendFn<any>
  | PromiseLike<unknown>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type Wake<T = void> = ([T] extends [void]
  ? () => void
  : (value: T) => void) & { throw(error: unknown): void };

/** Resume payload of a yielded shape — child Animator's R, SuspendFn's T,
 *  or void for non-typed yields. Used by `race` / `all` to type wakes. */
export type PayloadOf<Y> =
  Y extends Animator<infer R> ? R
  : Y extends SuspendFn<infer R> ? R
  : void;

/** Spawn an inner generator from a SuspendFn body; returns a disposer. */
export type SpawnFn = <R>(
  g: Animator<R> | (() => Animator<R>),
  onDone?: (v: R) => void,
) => () => void;

/** SuspendFn signature: `(wake, spawn, anim) => dispose`. The `anim`
 *  arg exposes `clock`, `onFrame`, and `run`. New SuspendFns may
 *  ignore `spawn` and use `anim.run(...)` instead — both shapes are
 *  supported (the engine arity-dispatches). */
export type SuspendFn<T = void> = (
  wake: Wake<T>,
  spawn: SpawnFn,
  anim: Anim,
) => () => void;

/** Optional per-engine lifecycle observer (assert/spans). One slot;
 *  user code composes multiple subscribers. */
export interface AnimObserver {
  spawn?(id: number, parentId: number | undefined, clock: number, gen: Animator<any>): void;
  complete?(id: number, clock: number): void;
  cancel?(id: number, clock: number): void;
}

export const isGen = (v: unknown): v is Animator =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { next?: unknown }).next === "function";
const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { then?: unknown }).then === "function";

type OnSettle = (v: unknown, slot: number, err: unknown) => void;

interface Ticker {
  cb: (dt: number, t: number) => void;
  alive: boolean;
  /** Engine clock at registration; per-tick `t` is `clock - t0`. */
  t0: number;
}

class Active {
  wakeAt = READY;
  cleanup: (() => void) | null = null;
  onSettle: OnSettle | null = null;
  /** Slot in parent's `parallel` results; 0 otherwise. */
  slot = 0;
  /** Re-entrancy guards — cancel-during-advance defers `gen.return()`. */
  busy = false;
  pendingReturn = false;
  /** Observer ID; 0 means unobserved. */
  observeId = 0;
  parent: Active | null = null;
  constructor(readonly gen: Animator) {}
}

export class Anim {
  protected actives: Active[] = [];
  private tickers: Ticker[] = [];
  private deads = 0;
  private nextObserveId = 0;
  observer: AnimObserver | undefined = undefined;
  onError: (e: unknown) => void = (e) => {
    console.error("minim:", e);
  };
  clock = 0;

  /** Run `g` (or its result if a factory). Returns a disposer. */
  run<R = any>(
    g: Animator<R> | (() => Animator<R>),
    onDone?: (v: R) => void,
  ): () => void {
    const onSettle: OnSettle | null = onDone
      ? (v, _i, err) => {
          if (err === undefined) onDone(v as R);
        }
      : null;
    const a = this.spawn(
      (typeof g === "function" ? g() : g) as Animator,
      null,
      onSettle,
    );
    return () => this.cancel(a);
  }

  /** Cancel everything; reset clock. */
  stop(): void {
    const snap = this.actives.slice();
    this.actives.length = 0;
    this.tickers.length = 0;
    this.clock = 0;
    for (const a of snap) this.cancel(a);
  }

  /** Per-frame callback `(dt, t-since-registration)`. Returns a disposer. */
  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t: Ticker = { cb, alive: true, t0: this.clock };
    this.tickers.push(t);
    return () => {
      t.alive = false;
    };
  }

  step(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.clock += dt;
    const c = this.clock;
    const ts = this.tickers;
    const len = ts.length;
    let w = 0;
    for (let i = 0; i < len; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      try {
        t.cb(dt, c - t.t0);
      } catch (e) {
        this.onError(e);
        t.alive = false;
      }
      if (t.alive) ts[w++] = t;
    }
    if (ts.length > len) for (let i = len; i < ts.length; i++) ts[w++] = ts[i];
    ts.length = w;
    const as = this.actives;
    const alen = as.length;
    const d0 = this.deads;
    for (let i = 0; i < alen; i++) {
      const a = as[i];
      if (!a || a.wakeAt === DEAD || a.wakeAt === PARKED) continue;
      if (a.wakeAt <= c) {
        a.wakeAt = READY;
        this.advance(a, dt, false);
      }
    }
    if (this.deads !== d0) {
      let cw = 0;
      for (let i = 0; i < as.length; i++)
        if (as[i].wakeAt !== DEAD) as[cw++] = as[i];
      as.length = cw;
      this.deads = 0;
    }
  }

  protected spawn(
    gen: Animator,
    parent: Active | null,
    onSettle: OnSettle | null,
    slot = 0,
  ): Active {
    const a = new Active(gen);
    a.onSettle = onSettle;
    a.slot = slot;
    a.parent = parent;
    this.actives.push(a);
    if (this.observer) {
      a.observeId = ++this.nextObserveId;
      this.observer.spawn?.(
        a.observeId,
        parent?.observeId || undefined,
        this.clock,
        gen,
      );
    }
    this.advance(a, undefined, false);
    return a;
  }

  protected cancel(a: Active): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD;
    this.deads++;
    this.observer?.cancel?.(a.observeId, this.clock);
    const c = a.cleanup;
    a.cleanup = null;
    a.onSettle = null;
    this.safe(c);
    if (a.busy) {
      a.pendingReturn = true;
      return;
    }
    try {
      a.gen.return(undefined);
    } catch (e) {
      this.onError(e);
    }
  }

  private safe(fn: (() => void) | null | undefined): void {
    try {
      fn?.();
    } catch (e) {
      this.onError(e);
    }
  }

  protected settle(
    a: Active,
    value: unknown,
    errored: boolean,
    error: unknown,
  ): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD;
    this.deads++;
    if (!errored) this.observer?.complete?.(a.observeId, this.clock);
    const cb = a.onSettle;
    a.onSettle = null;
    if (cb)
      cb(errored ? undefined : value, a.slot, errored ? error : undefined);
    else if (errored) this.onError(error);
  }

  private advance(a: Active, payload: unknown, asThrow: boolean): void {
    a.busy = true;
    try {
      const r = asThrow ? a.gen.throw(payload) : a.gen.next(payload);
      if (r.done) return this.settle(a, r.value, false, undefined);
      if (a.wakeAt === DEAD) return;
      const v = r.value;
      if (v === undefined) return;
      if (typeof v === "number") {
        if (v > 0) a.wakeAt = this.clock + v;
        return;
      }
      if (typeof v === "function") return this.suspend(a, v);
      if (Array.isArray(v)) return this.parallel(a, v);
      if (isGen(v)) return this.child(a, v);
      if (isThenable(v)) return this.thenable(a, v);
      throw new TypeError(`anim: unsupported yield ${typeof v}`);
    } catch (e) {
      this.settle(a, undefined, true, e);
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try {
          a.gen.return(undefined);
        } catch (e) {
          this.onError(e);
        }
      }
    }
  }

  private suspend(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const finish = (action: () => void): void => {
      if (resumed || a.wakeAt === DEAD) return;
      resumed = true;
      const c = a.cleanup;
      a.cleanup = null;
      a.wakeAt = READY;
      this.safe(c);
      action();
    };
    const wake = ((v?: unknown) =>
      finish(() => this.advance(a, v, false))) as Wake<any>;
    wake.throw = (e: unknown): void => finish(() => this.advance(a, e, true));
    // Per-suspend spawn closure: spawned children inherit `a` as parent
    // (so observer / cancel cascade can walk the tree), and cancelling
    // the parent cancels the child.
    const spawnFn: SpawnFn = (g, onDone) => {
      const onSettle: OnSettle | null = onDone
        ? (v, _i, err) => {
            if (err === undefined) onDone(v as never);
          }
        : null;
      const child = this.spawn(
        (typeof g === "function" ? g() : g) as Animator,
        a,
        onSettle,
      );
      return () => this.cancel(child);
    };
    let dispose: () => void;
    try {
      dispose = impl(wake, spawnFn, this);
    } catch (e) {
      if (!resumed && a.wakeAt !== DEAD) {
        resumed = true;
        this.advance(a, e, true);
      } else this.onError(e);
      return;
    }
    if (resumed || a.wakeAt === DEAD) this.safe(dispose);
    else {
      a.wakeAt = PARKED;
      a.cleanup = dispose;
    }
  }

  private thenable(a: Active, p: PromiseLike<unknown>): void {
    a.wakeAt = PARKED;
    let cancelled = false;
    a.cleanup = () => {
      cancelled = true;
    };
    p.then(
      (v) => {
        if (!cancelled && a.wakeAt !== DEAD) {
          a.cleanup = null;
          a.wakeAt = READY;
          this.advance(a, v, false);
        }
      },
      (e) => {
        if (!cancelled && a.wakeAt !== DEAD) {
          a.cleanup = null;
          a.wakeAt = READY;
          this.advance(a, e, true);
        }
      },
    );
  }

  private child(a: Active, child: Animator): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => {
      if (c && c.wakeAt !== DEAD) this.cancel(c);
    };
    c = this.spawn(child, a, (v, _i, err) => {
      if (a.wakeAt === DEAD || a.cleanup === null) return;
      a.cleanup = null;
      a.wakeAt = READY;
      this.advance(a, err === undefined ? v : err, err !== undefined);
    });
  }

  private parallel(a: Active, kids: readonly Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, [], false);
    for (const k of kids)
      if (!isGen(k))
        throw new TypeError("anim: parallel array elements must be Animators");
    const children: Active[] = [];
    const results = new Array<unknown>(kids.length);
    let left = kids.length;
    let aborted = false;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      aborted = true;
      for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
    };
    const onChild: OnSettle = (value, slot, error) => {
      if (aborted) return;
      if (error !== undefined) {
        aborted = true;
        a.cleanup = null;
        a.wakeAt = READY;
        for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
        this.advance(a, error, true);
        return;
      }
      results[slot] = value;
      if (--left === 0) {
        aborted = true;
        a.cleanup = null;
        a.wakeAt = READY;
        this.advance(a, results, false);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (aborted) return;
      // `slot` MUST be set before spawn calls advance — sync-completing
      // kids would otherwise see slot=0 and corrupt `results`.
      children.push(this.spawn(kids[j] as Animator, a, onChild, j));
    }
  }
}

/** Per-frame callback. `yield* drive(cb)` (or `anim.run(drive(cb))`)
 *  parks until `cb` returns `false`. Each tick is one function call —
 *  no generator resumption. `cb` throws → propagates to parent's yield. */
export function drive(
  cb: (dt: number, t: number) => boolean | void,
): Animator {
  return suspend<void>((wake, _spawn, anim) =>
    anim.onFrame((dt, t) => {
      try {
        if (cb(dt, t) === false) wake();
      } catch (e) {
        wake.throw(e);
      }
    }),
  );
}

/** `yield* suspend(impl)` parks until `wake(value)`; resumes with `value`. */
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

/** Browser RAF adapter. Caps single-frame dt at 32 ms so tab-switch
 *  catch-up doesn't fire one giant step. Returns a detach function. */
export function attachRaf(anim: Anim): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  const FRAME_CAP_MS = 32;
  let rafId = 0;
  let last = 0;
  const tick = (now: number): void => {
    rafId = requestAnimationFrame(tick);
    const dt = last ? Math.min(now - last, FRAME_CAP_MS) / 1000 : 0;
    last = now;
    anim.step(dt);
  };
  rafId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(rafId);
}
