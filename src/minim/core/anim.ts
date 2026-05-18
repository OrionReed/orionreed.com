// Generator-driven cooperative animation runtime
//
// Yield contract:
//   undefined     park 1 frame; resume with dt
//   number > 0    sleep N seconds; resume with dt
//   number ≤ 0    tail-call; resume immediately (no frame consumed)
//   Animator      spawn child; resume with R when it completes
//   Yieldable[]   run concurrently; resume with results[]
//   Suspend       callback-wake; resume with wake's value
//   detach(g)     spawn at engine root; resume immediately

const DEAD = -Infinity;
const READY = 0;
const PARKED = Infinity;

const DETACH_KEY = Symbol.for("minim.detach");

// ── Types ─────────────────────────────────────────────────────────────

export type Yieldable =
  | undefined
  | number
  | Animator<any>
  | readonly Yieldable[]
  | Suspend<any>
  | Detach;

export type Animator<R = void> = Generator<Yieldable, R, number>;

export type Wake<T = void> = ([T] extends [void]
  ? () => void
  : (value: T) => void) & { throw(error: unknown): void };

/** Resume value of a yielded shape — the type you receive after the
 *  yield completes. Animator → its return value; Suspend → wake's T. */
export type Resume<Y> =
  Y extends Animator<infer R> ? R : Y extends Suspend<infer R> ? R : void;

/** Spawn a child Active from inside a Suspend impl. Optional `scale`
 *  installs a time-scale on the spawned active (and its descendants). */
export type SpawnFn = <R>(
  g: Animator<R> | (() => Animator<R>),
  onDone?: (v: R) => void,
  scale?: () => number,
) => () => void;

/** Callback-wake park primitive. Yielding a `Suspend<T>` parks the
 *  active; the impl receives `wake` and may call `wake(value)` to
 *  resume the gen, or `wake.throw(e)` to throw into it. Children
 *  spawned via `spawn` are auto-cancelled when the parent ends. */
export type Suspend<T = void> = (
  wake: Wake<T>,
  spawn: SpawnFn,
  anim: Anim,
) => void | (() => void);

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

export type Detach = { readonly [k: symbol]: Animator };

export const detach = <R>(g: Animator<R>): Detach => ({
  [DETACH_KEY]: g as Animator,
});

export const isGen = (v: unknown): v is Animator =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { next?: unknown }).next === "function";

/** Wrap a non-generator Yieldable in a one-shot gen (for concurrent). */
export function* asGen(y: Yieldable): Animator<any> {
  yield y;
}

type OnSettle = (value: unknown, error: unknown) => void;

class Active {
  /** READY (0): ready to advance. PARKED (Inf): waiting on external wake.
   *  DEAD (-Inf): settled or cancelled. Positive: sleep target. */
  wakeAt = READY;
  /** Accumulated scaled time. Only advanced for scaled actives; for
   *  unscaled ones this stays 0 and wakeAt lives in engine time. */
  localClock = 0;
  /** Own time-scale factor. null = identity (unscaled). */
  scale: (() => number) | null = null;
  /** True iff scale set on self OR any ancestor. Decides fast vs scaled
   *  path in step(). Computed once at spawn. */
  inScaledSubtree = false;
  /** Cached cumScale; valid only when `cumScaleStep === Anim.stepN`. */
  cumScale = 1;
  cumScaleStep = 0;
  cleanup: (() => void) | null = null;
  onSettle: OnSettle | null = null;
  /** Re-entrancy guard: cancel-during-advance defers gen.return(). */
  busy = false;
  pendingReturn = false;
  observeId = 0;
  parent: Active | null = null;
  // gen is `Animator<any>` (bivariant in R) because Active is the
  // engine's internal handle — the public typed `Animator<R>` lands
  // here via spawn() and we erase R because the engine just needs
  // .next/.throw/.return, not the return type.
  constructor(readonly gen: Animator<any>) {}
}

export class Anim {
  protected actives: Active[] = [];
  private deads = 0;
  private nextObserveId = 0;
  /** Incremented each step(). Used to invalidate the per-step
   *  cumScale cache on each Active. */
  private stepN = 0;
  private stepListeners: Set<(dt: number) => void> | null = null;

  observer: AnimObserver | undefined = undefined;
  onError: (e: unknown) => void = (e) => {
    console.error("minim:", e);
  };

  #clock = 0;
  get clock(): number {
    return this.#clock;
  }

  start(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(asAnimator(g), null, null);
    return () => this.cancel(a);
  }

  onStep(cb: (dt: number) => void): () => void {
    (this.stepListeners ??= new Set()).add(cb);
    return () => {
      this.stepListeners?.delete(cb);
    };
  }

  stop(): void {
    const snap = this.actives.slice();
    this.actives.length = 0;
    this.#clock = 0;
    for (const a of snap) this.cancel(a);
  }

  step(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.#clock += dt;
    this.stepN++;
    if (this.stepListeners) {
      for (const cb of this.stepListeners) {
        try {
          cb(dt);
        } catch (e) {
          this.onError(e);
        }
      }
    }
    const c = this.#clock;
    const as = this.actives;
    const alen = as.length;
    const d0 = this.deads;
    for (let i = 0; i < alen; i++) {
      const a = as[i];
      if (!a || a.wakeAt === DEAD || a.wakeAt === PARKED) continue;

      // FAST PATH: unscaled — baseline behaviour, no bookkeeping.
      if (!a.inScaledSubtree) {
        if (a.wakeAt <= c) {
          a.wakeAt = READY;
          this.advance(a, dt, false);
        }
        continue;
      }

      // SCALED PATH: cumScale (inline cache fast-path) + local-time
      // wakeAt + pause-skip on cumScale=0.
      let cs: number;
      if (a.cumScaleStep === this.stepN) {
        cs = a.cumScale;
      } else {
        const own = a.scale ? a.scale() : 1;
        const p = a.parent;
        const pcs =
          p === null
            ? 1
            : p.cumScaleStep === this.stepN
              ? p.cumScale
              : this.cumScaleOf(p);
        cs = own * pcs;
        a.cumScale = cs;
        a.cumScaleStep = this.stepN;
      }
      if (cs === 0) continue;
      const scaledDt = dt * cs;
      if (scaledDt > 0) a.localClock += scaledDt;
      if (a.wakeAt <= a.localClock) {
        a.wakeAt = READY;
        this.advance(a, scaledDt, false);
      }
    }
    if (this.deads !== d0) this.compact();
  }

  /** Slow path of the cumScale cache. Only called when an active's
   *  parent's cumScale is also stale; recurses up until it hits a
   *  cached or null parent, caching along the way back down. */
  private cumScaleOf(a: Active): number {
    if (a.cumScaleStep === this.stepN) return a.cumScale;
    const own = a.scale ? a.scale() : 1;
    const p = a.parent;
    const pcs =
      p === null
        ? 1
        : p.cumScaleStep === this.stepN
          ? p.cumScale
          : this.cumScaleOf(p);
    const cs = own * pcs;
    a.cumScale = cs;
    a.cumScaleStep = this.stepN;
    return cs;
  }

  protected spawn(
    gen: Animator<any>,
    parent: Active | null,
    onSettle: OnSettle | null,
    scale: (() => number) | null = null,
  ): Active {
    const a = new Active(gen);
    a.onSettle = onSettle;
    a.parent = parent;
    // Set scale + inScaledSubtree BEFORE the initial advance — the gen
    // may immediately yield a concurrent/race, spawning grandchildren
    // that need the right flag.
    if (scale) {
      a.scale = scale;
      a.inScaledSubtree = true;
    } else {
      a.inScaledSubtree = parent?.inScaledSubtree === true;
    }
    this.actives.push(a);
    if (this.observer) {
      a.observeId = ++this.nextObserveId;
      this.observer.spawn?.(
        a.observeId,
        parent?.observeId || undefined,
        this.#clock,
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
    this.observer?.cancel?.(a.observeId, this.#clock);
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

  protected settle(
    a: Active,
    value: unknown,
    errored: boolean,
    error: unknown,
  ): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD;
    this.deads++;
    if (!errored) this.observer?.complete?.(a.observeId, this.#clock);
    const cb = a.onSettle;
    a.onSettle = null;
    if (cb) cb(errored ? undefined : value, errored ? error : undefined);
    else if (errored) this.onError(error);
  }

  private safe(fn: (() => void) | null | undefined): void {
    if (!fn) return;
    try {
      fn();
    } catch (e) {
      this.onError(e);
    }
  }

  private compact(): void {
    const as = this.actives;
    let w = 0;
    for (let i = 0; i < as.length; i++) {
      if (as[i].wakeAt !== DEAD) as[w++] = as[i];
    }
    as.length = w;
    this.deads = 0;
  }

  private advance(a: Active, payload: any, asThrow: boolean): void {
    a.busy = true;
    try {
      let r = asThrow ? a.gen.throw(payload) : a.gen.next(payload);
      while (!r.done) {
        if (a.wakeAt === DEAD) return;
        const v = r.value;
        if (v === undefined) return; // park 1 frame
        if (typeof v === "number") {
          if (v > 0) {
            a.wakeAt = a.inScaledSubtree ? a.localClock + v : this.#clock + v;
            return;
          }
          // Tail-call: yield N ≤ 0 resumes synchronously. Used by
          // conditional sleeps like `holding(sig, v, dur)` where dur
          // may evaluate to 0 — no frame penalty for zero wait.
          r = a.gen.next(0);
          continue;
        }
        if (typeof v === "function") return this.suspend(a, v);
        if (Array.isArray(v)) return this.concurrent(a, v);
        if (isGen(v)) return this.child(a, v);
        if (typeof v === "object" && v !== null && DETACH_KEY in v) {
          this.spawn((v as Record<symbol, Animator>)[DETACH_KEY], null, null);
          r = a.gen.next(0);
          continue;
        }
        throw new TypeError(`anim: unsupported yield (${describe(v)})`);
      }
      this.settle(a, r.value, false, undefined);
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

  /** `yield Suspend` — park `a`, give the impl a wake callback. Children
   *  spawned via the `spawn` arg auto-cancel with the parent (safety
   *  net + makes dispose optional in the common case). */
  private suspend(a: Active, impl: Suspend<any>): void {
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
    wake.throw = (e: unknown) => finish(() => this.advance(a, e, true));

    let subKids: Active[] | null = null;
    const spawnFn: SpawnFn = (g, onDone, scale?) => {
      const cb: OnSettle | null = onDone
        ? (v, err) => {
            if (err === undefined) onDone(v as never);
          }
        : null;
      const child = this.spawn(asAnimator(g), a, cb, scale ?? null);
      (subKids ??= []).push(child);
      return () => this.cancel(child);
    };

    let userDispose: (() => void) | undefined;
    try {
      userDispose = impl(wake, spawnFn, this) ?? undefined;
    } catch (e) {
      if (!resumed && a.wakeAt !== DEAD) {
        resumed = true;
        this.advance(a, e, true);
      } else {
        this.onError(e);
      }
      return;
    }

    // Cleanup runs the user's dispose then cascade-cancels any
    // auto-tracked children. Checking subKids at call-time (not setup)
    // catches children attached late, after impl returned.
    const dispose = (): void => {
      this.safe(userDispose);
      if (subKids) {
        const ks = subKids;
        subKids = null;
        for (const c of ks) if (c.wakeAt !== DEAD) this.cancel(c);
      }
    };

    if (resumed || a.wakeAt === DEAD) {
      this.safe(dispose);
    } else {
      a.wakeAt = PARKED;
      a.cleanup = dispose;
    }
  }

  /** `yield Animator` — spawn child, park parent until it settles.
   *  Distinct from `yield*` so tracers see the child as its own span. */
  private child(a: Active, child: Animator): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => {
      if (c && c.wakeAt !== DEAD) this.cancel(c);
    };
    c = this.spawn(child, a, (v, err) => {
      if (a.wakeAt === DEAD || a.cleanup === null) return;
      a.cleanup = null;
      a.wakeAt = READY;
      this.advance(a, err === undefined ? v : err, err !== undefined);
    });
  }

  /** `yield [a, b, ...]` — run kids concurrently; resume with the
   *  results tuple when all complete. First error cancels the rest. */
  private concurrent(a: Active, kids: readonly Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, [], false);

    const children: Active[] = [];
    const results = new Array<unknown>(kids.length);
    let left = kids.length;
    let aborted = false;

    a.wakeAt = PARKED;
    a.cleanup = () => {
      aborted = true;
      for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
    };

    const settle = (v: unknown, asThrow: boolean): void => {
      aborted = true;
      a.cleanup = null;
      a.wakeAt = READY;
      if (asThrow) {
        for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
      }
      this.advance(a, v, asThrow);
    };

    for (let j = 0; j < kids.length; j++) {
      if (aborted) return;
      const k = kids[j];
      const idx = j;
      children.push(
        this.spawn(isGen(k) ? k : asGen(k), a, (value, error) => {
          if (aborted) return;
          if (error !== undefined) return settle(error, true);
          results[idx] = value;
          if (--left === 0) settle(results, false);
        }),
      );
    }
  }
}

/** Coerce `Animator | (() => Animator)` to `Animator`. */
function asAnimator<R>(g: Animator<R> | (() => Animator<R>)): Animator<R> {
  return typeof g === "function" ? g() : g;
}

/** Compact description of a value for error messages. */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (typeof v !== "object") return String(v);
  return (
    (v as { constructor?: { name?: string } }).constructor?.name ?? "object"
  );
}
