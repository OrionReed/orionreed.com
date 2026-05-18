// Generator-driven cooperative animation runtime.
//
// Three structural attributes a spawned child can carry — each is a
// yield-shape (a symbol-keyed object) the engine dispatches on:
//
//   detach(g)         — child outlives parent (lifecycle-independent)
//   scaled(rate, g)   — child's dt is time-warped (rate-independent)
//   cut(v)            — kid's *return value*; settles enclosing group
//                       with v, cancels siblings (settlement-shape)
//
// Plus the primary yield meanings:
//
//   undefined     park 1 frame; resume with dt
//   number > 0    sleep N seconds; resume with dt
//   number ≤ 0    tail-call; resume immediately (no frame consumed)
//   Animator      spawn child; resume with its return value
//   Yieldable[]   run concurrently; resume with results[]
//   Suspend       callback-wake (pure `(wake) => dispose`)
//
// Cut is *return-based only* and *lexically scoped*: a kid in a
// concurrent group whose final value is `cut(v)` settles its direct
// parent group with `v`. Outside a group, `cut(v)` is unwrapped to
// `v` (Prolog's `!` outside a choice point is a no-op).

const DEAD = -Infinity;
const READY = 0;
const PARKED = Infinity;

const DETACH_KEY = Symbol.for("minim.detach");
const SCALE_KEY = Symbol.for("minim.scale");
const CUT_KEY = Symbol.for("minim.cut");

// ── Types ─────────────────────────────────────────────────────────────

export type Yieldable =
  | undefined
  | number
  | Animator<any>
  | readonly Yieldable[]
  | Suspend<any>
  | Detach
  | Scaled<any>;

export type Animator<R = void> = Generator<Yieldable, R, number>;

export type Wake<T = void> = ([T] extends [void]
  ? () => void
  : (value: T) => void) & { throw(error: unknown): void };

/** Resume value of a yielded shape — the type you receive after the
 *  yield completes. Animator → its return value; Suspend → wake's T;
 *  Scaled → inner gen's return. */
export type Resume<Y> =
  Y extends Animator<infer R> ? R
  : Y extends Suspend<infer R> ? R
  : Y extends Scaled<infer R> ? R
  : void;

/** Callback-wake park primitive. Yielding a `Suspend<T>` parks the
 *  active; the impl receives `wake` and may call `wake(value)` to
 *  resume the gen, or `wake.throw(e)` to throw into it. Return an
 *  optional disposer that runs on cancel. */
export type Suspend<T = void> = (wake: Wake<T>) => void | (() => void);

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

// ── Yield shapes (structural attributes) ─────────────────────────────

export type Detach = { readonly [DETACH_KEY]: Animator };

/** Spawn `g` at engine-root, outliving the yielding parent. Resume is
 *  synchronous (the parent does NOT park). Use sparingly — most
 *  animations should be scoped to their parent's lifetime. */
export const detach = <R>(g: Animator<R>): Detach => ({
  [DETACH_KEY]: g as Animator,
});

/** Spawn the inner gen with `rate` as its time-scale. All descendants
 *  inherit the scale through the parent chain. `rate() === 0` skips the
 *  entire subtree (gen.next is never called → no work, sleeps frozen). */
export type Scaled<R> = {
  readonly [SCALE_KEY]: { readonly rate: () => number; readonly gen: Animator<R> };
};
export const scaled = <R>(rate: () => number, gen: Animator<R>): Scaled<R> => ({
  [SCALE_KEY]: { rate, gen },
});

/** Cut sentinel — a kid in a concurrent group whose final value is
 *  `cut(v)` settles the group with `v` and cancels siblings. Outside a
 *  group, `cut(v)` is silently unwrapped to `v` by the child/suspend
 *  paths (Prolog's `!` semantics). */
export type Cut<T> = { readonly [CUT_KEY]: T };
export const cut = <T>(value: T): Cut<T> => ({ [CUT_KEY]: value });
export const isCut = (v: unknown): v is Cut<unknown> =>
  v !== null && typeof v === "object" && CUT_KEY in (v as object);
const cutValue = <T>(v: Cut<T>): T => (v as { [CUT_KEY]: T })[CUT_KEY];
const unwrapIfCut = (v: unknown): unknown =>
  isCut(v) ? cutValue(v) : v;

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
          // conditional sleeps where `dur` may evaluate to 0 — no
          // frame penalty for zero wait.
          r = a.gen.next(0);
          continue;
        }
        if (typeof v === "function") return this.suspend(a, v);
        if (Array.isArray(v)) return this.concurrent(a, v);
        if (isGen(v)) return this.child(a, v);
        if (typeof v === "object" && v !== null) {
          if (DETACH_KEY in v) {
            this.spawn((v as Record<symbol, Animator>)[DETACH_KEY], null, null);
            r = a.gen.next(0);
            continue;
          }
          if (SCALE_KEY in v) {
            const { rate, gen } = (v as Scaled<any>)[SCALE_KEY];
            return this.scaledChild(a, gen, rate);
          }
        }
        throw new TypeError(`anim: unsupported yield (${describe(v)})`);
      }
      // Return-based cut is detected by `concurrent()`'s kid callback;
      // for non-group consumers (child, top-level), unwrap happens at
      // the consumer site so cut() outside a group is transparent.
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

  /** `yield Suspend` — park `a`, give the impl a wake callback. */
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
      finish(() => this.advance(a, unwrapIfCut(v), false))) as Wake<any>;
    wake.throw = (e: unknown) => finish(() => this.advance(a, e, true));

    let dispose: (() => void) | undefined;
    try {
      dispose = impl(wake) ?? undefined;
    } catch (e) {
      if (!resumed && a.wakeAt !== DEAD) {
        resumed = true;
        this.advance(a, e, true);
      } else {
        this.onError(e);
      }
      return;
    }

    if (resumed || a.wakeAt === DEAD) {
      this.safe(dispose);
    } else {
      a.wakeAt = PARKED;
      a.cleanup = dispose ?? null;
    }
  }

  /** `yield Animator` — spawn child, park parent until it settles.
   *  Distinct from `yield*` so tracers see the child as its own span.
   *  Unwraps a Cut return value transparently. */
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
      this.advance(a, err === undefined ? unwrapIfCut(v) : err, err !== undefined);
    });
  }

  /** `yield scaled(rate, g)` — spawn `g` as a scaled child active,
   *  park parent until it settles. Symmetric with `child()` except for
   *  the scale arg passed to spawn. */
  private scaledChild(a: Active, gen: Animator, rate: () => number): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => {
      if (c && c.wakeAt !== DEAD) this.cancel(c);
    };
    c = this.spawn(gen, a, (v, err) => {
      if (a.wakeAt === DEAD || a.cleanup === null) return;
      a.cleanup = null;
      a.wakeAt = READY;
      this.advance(a, err === undefined ? unwrapIfCut(v) : err, err !== undefined);
    }, rate);
  }

  /** `yield [a, b, ...]` — run kids concurrently. Settles with the
   *  results tuple when every kid completes; a kid returning `cut(v)`
   *  settles the group immediately with `v` and cancels remaining
   *  siblings. First error from any kid also cancels the rest. */
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

    const settle = (v: unknown, asThrow: boolean, cancelSibs: boolean): void => {
      if (aborted) return;
      aborted = true;
      a.cleanup = null;
      a.wakeAt = READY;
      if (cancelSibs) {
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
          if (error !== undefined) return settle(error, true, true);
          // Return-based cut: kid's final value is a Cut. Settle the
          // group with the unwrapped inner value, cancel siblings.
          if (isCut(value)) return settle(cutValue(value), false, true);
          results[idx] = value;
          if (--left === 0) settle(results, false, false);
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
