//   Yield contract:
//   undefined       park 1 frame
//   number > 0      sleep N (subjective) seconds
//   Animator        spawn child, await its return value
//   Suspend         callback-wake `(wake, spawn) => dispose`
//   Transduced      spawn `gen` with attached transducer stack
//   Yieldable[]     run concurrently; resume with results[]
//
//   Resume values are either:
//   Tick, a { dt: number, elapsed: number } object
//   Example: `const { dt } = yield;`
//
//   T (generic), if the suspend is `(wake, spawn) => T`
//   Example: `const result = yield (wake, spawn) => { ... }`

export interface Tick {
  readonly dt: number;
  readonly elapsed: number;
}

export type Yieldable =
  | undefined
  | number
  | Animator<any>
  | readonly Yieldable[]
  | Suspend<any>
  | Transduced<any>;

export type Animator<R = void> = Generator<Yieldable, R, Tick>;

export type Suspend<T = void> = (
  wake: Wake<T>,
  /** Spawn `g` at engine root, returning a cancel handle. **/
  spawn: (g: Animator<any>) => () => void,
) => void | (() => void);

export type Resume<Y> =
  Y extends Animator<infer R>
    ? R
    : Y extends Suspend<infer R>
      ? R
      : Y extends Transduced<infer R>
        ? R
        : void;

export type Cut<T> = { readonly [CUT_KEY]: T };

export interface Transducer {
  /** gen → engine direction: transform an outgoing yield. */
  onYield?(v: Yieldable): Yieldable | undefined;
  /** engine → gen direction: transform an incoming resume payload (on wake). */
  onResume?(tick: Tick): Tick | undefined;
  /** engine internal: per-step time advancement. Return 0 to freeze the
   *  active for this frame (no localClock advance, no wake check). */
  onTick?(dt: number): number;
}

/** Generator + per-hook function stacks. Internally we keep three arrays
 *  instead of one Transducer[] so the per-step cost of unused hooks is
 *  literally zero (empty loop). `R` is the wrapped gen's return type —
 *  recoverable via `Resume<Transduced<R>>`. Stack order in each array
 *  is outermost-first; `onTick` walks the array in reverse (innermost
 *  first, so descendants see scaled dt first); `onYield` and `onResume`
 *  walk it forward (so the gen sees the outermost transform last). */
export interface Transduced<R = unknown> {
  readonly [TRANSDUCE_KEY]: true;
  readonly gen: Animator<R>;
  readonly ticks: readonly ((dt: number) => number)[];
  readonly resumes: readonly ((tick: Tick) => Tick | undefined)[];
  readonly yields: readonly ((v: Yieldable) => Yieldable | undefined)[];
}

export const TRANSDUCE_KEY = Symbol("transduce");

// ─── Public helpers ──────────────────────────────────────────────────

/** Cut sentinel — return `cut(v)` from a concurrent kid to settle the
 *  enclosing group with `v` and cancel siblings. Outside a group, the
 *  sentinel is transparently unwrapped to `v`. */
export const cut = <T>(value: T): Cut<T> => ({ [CUT_KEY]: value });

/** Stack `t` on top of `target`. Splits `t`'s hooks into the three per-hook
 *  arrays — non-defined hooks reuse the target's array (no allocation).
 *  Preserves the wrapped gen's return type through composition. */
export function transduce<R>(
  t: Transducer,
  target: Animator<R> | Transduced<R>,
): Transduced<R> {
  if (isTransduced(target)) {
    return {
      [TRANSDUCE_KEY]: true,
      gen: target.gen as Animator<R>,
      ticks: pushStack(t.onTick, target.ticks),
      resumes: pushStack(t.onResume, target.resumes),
      yields: pushStack(t.onYield, target.yields),
    };
  }
  return {
    [TRANSDUCE_KEY]: true,
    gen: target,
    ticks: t.onTick ? [t.onTick] : EMPTY,
    resumes: t.onResume ? [t.onResume] : EMPTY,
    yields: t.onYield ? [t.onYield] : EMPTY,
  };
}

/** True if `v` is a Generator (duck-typed via `.next`). */
export const isGenerator = (v: unknown): v is Animator =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { next?: unknown }).next === "function";

// ─── Runtime ─────────────────────────────────────────────────────────

export class Anim {
  protected actives: Active[] = [];
  private deads = 0;
  /** Re-entry guard: true while `step()` is iterating. Calling `step()`
   *  again from inside a transducer hook or a gen body throws. Other ops
   *  (start, stop, cancel) remain legal from inside step — they only
   *  mutate `actives`, which the loop handles via index + skip-checks. */
  private stepping = false;
  private stepListeners: Set<(dt: number) => void> | null = null;

  onError: (e: unknown) => void = (e) => {
    console.error("minim:", e);
  };

  #clock = 0;
  get clock(): number {
    return this.#clock;
  }

  /** Spawn one or more root-level actives. Each Yieldable becomes an
   *  independent active; the returned handle cancels all of them. Pass
   *  an array (`[a, b]`) as a single Yieldable to spawn a concurrent
   *  group with cascading cancel + joined completion instead. */
  start(...gs: Yieldable[]): () => void {
    if (gs.length === 0) return () => {};
    const actives = gs.map((g) => {
      if (isGeneratorFunction(g)) {
        throw new TypeError(
          `anim.start: received a generator function; pass an instance instead — \`anim.start(${(g as Function).name || "g"}())\``,
        );
      }
      if (isGenerator(g)) return this.spawn(g, null, null, EMPTY, EMPTY, EMPTY);
      if (isTransduced(g))
        return this.spawn(g.gen, null, null, g.ticks, g.resumes, g.yields);
      return this.spawn(asGen(g), null, null, EMPTY, EMPTY, EMPTY);
    });
    return () => {
      for (const a of actives) this.cancel(a);
    };
  }

  /** Fire `cb(dt)` after every successful `step()` completes. */
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
    if (this.stepping) {
      throw new Error("minim: re-entrant step() is not supported");
    }
    this.stepping = true;
    try {
      this.stepInner(dt);
    } finally {
      this.stepping = false;
    }
    if (this.stepListeners) {
      for (const cb of this.stepListeners) {
        try {
          cb(dt);
        } catch (e) {
          this.onError(e);
        }
      }
    }
  }

  private stepInner(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.#clock += dt;

    const as = this.actives;
    const alen = as.length;
    const d0 = this.deads;
    for (let i = 0; i < alen; i++) {
      const a = as[i];
      if (!a || a.wakeAt === DEAD || a.wakeAt === PARKED) continue;

      // Per-active time advance. Always walk the ticks stack (fires even
      // at dt=0 so observation-style transducers see every step). Empty
      // stack → loop never enters → zero cost for the common case.
      const ticks = a.ticks;
      let subjDt = dt;
      for (let k = ticks.length - 1; k >= 0; k--) {
        subjDt = ticks[k](subjDt);
      }
      // Freeze only when the engine actually had time and the chain ate it.
      if (dt > 0 && subjDt === 0) continue;
      if (subjDt > 0) a.localClock += subjDt;

      if (a.wakeAt <= a.localClock) {
        const saved = a.wakeAt;
        a.wakeAt = READY;
        // Sub-frame: only the time since the wake threshold is "owed".
        const dtEff =
          saved > 0 ? Math.min(subjDt, a.localClock - saved) : subjDt;
        let tick: Tick = { dt: dtEff, elapsed: a.localClock };
        // onResume: outer-to-inner. Empty stack → no work.
        const resumes = a.resumes;
        for (let k = 0; k < resumes.length; k++) {
          tick = resumes[k](tick) ?? tick;
        }
        this.advance(a, tick, false);
      }
    }
    if (this.deads !== d0) this.compact();
  }

  protected spawn(
    gen: Animator<any>,
    parent: Active | null,
    onSettle: OnSettle | null,
    ticks: readonly ((dt: number) => number)[],
    resumes: readonly ((tick: Tick) => Tick | undefined)[],
    yields: readonly ((v: Yieldable) => Yieldable | undefined)[],
  ): Active {
    const a = new Active(gen);
    a.onSettle = onSettle;
    a.ticks = ticks;
    a.resumes = resumes;
    a.yields = yields;
    a.localClock = parent ? parent.localClock : 0;
    this.actives.push(a);
    this.advance(a, undefined, false);
    return a;
  }

  protected cancel(a: Active): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD;
    this.deads++;
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
    for (let i = 0; i < as.length; i++)
      if (as[i].wakeAt !== DEAD) as[w++] = as[i];
    as.length = w;
    this.deads = 0;
  }

  private advance(a: Active, payload: any, asThrow: boolean): void {
    a.busy = true;
    try {
      let r = asThrow ? a.gen.throw(payload) : a.gen.next(payload);
      while (!r.done) {
        if (a.wakeAt === DEAD) return;
        let v = r.value;

        // onYield: outer-to-inner. Empty stack → no work.
        const yields = a.yields;
        for (let k = 0; k < yields.length; k++) {
          const m = yields[k](v);
          if (m !== undefined) v = m;
        }

        if (v === undefined) return; // park 1 frame
        if (typeof v === "number") {
          // `yield N <= 0` parks (semantic alignment with `yield`).
          if (v > 0) a.wakeAt = a.localClock + v;
          return;
        }
        if (typeof v === "function") return this.suspend(a, v as Suspend<any>);
        if (Array.isArray(v)) return this.concurrent(a, v);
        if (isGenerator(v))
          return this.awaitChild(a, v, a.ticks, a.resumes, a.yields);
        if (isTransduced(v)) {
          return this.awaitChild(
            a,
            v.gen,
            composeStack(a.ticks, v.ticks),
            composeStack(a.resumes, v.resumes),
            composeStack(a.yields, v.yields),
          );
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
      finish(() => this.advance(a, unwrapCut(v), false))) as Wake<any>;
    wake.throw = (e: unknown) => finish(() => this.advance(a, e, true));

    const spawn = (g: Animator): (() => void) => {
      const child = this.spawn(g, null, null, EMPTY, EMPTY, EMPTY);
      return () => this.cancel(child);
    };

    let dispose: (() => void) | undefined;
    try {
      dispose = impl(wake, spawn) ?? undefined;
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
      a.cleanup = dispose ?? null;
    }
  }

  /** Park `a` and spawn `gen` as its child with the given transducer stacks;
   *  resume `a` with the child's return value (or error) on settle. */
  private awaitChild(
    a: Active,
    gen: Animator,
    ticks: readonly ((dt: number) => number)[],
    resumes: readonly ((tick: Tick) => Tick | undefined)[],
    yields: readonly ((v: Yieldable) => Yieldable | undefined)[],
  ): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => {
      if (c && c.wakeAt !== DEAD) this.cancel(c);
    };
    c = this.spawn(
      gen,
      a,
      (v, err) => {
        if (a.wakeAt === DEAD || a.cleanup === null) return;
        a.cleanup = null;
        a.wakeAt = READY;
        this.advance(
          a,
          err === undefined ? unwrapCut(v) : err,
          err !== undefined,
        );
      },
      ticks,
      resumes,
      yields,
    );
  }

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

    const settle = (
      v: unknown,
      asThrow: boolean,
      cancelSibs: boolean,
    ): void => {
      if (aborted) return;
      aborted = true;
      a.cleanup = null;
      a.wakeAt = READY;
      if (cancelSibs)
        for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
      this.advance(a, v, asThrow);
    };

    for (let j = 0; j < kids.length; j++) {
      if (aborted) return;
      const k = kids[j];
      const idx = j;
      let kidGen: Animator;
      let kidTicks: readonly ((dt: number) => number)[] = a.ticks;
      let kidResumes: readonly ((tick: Tick) => Tick | undefined)[] = a.resumes;
      let kidYields: readonly ((v: Yieldable) => Yieldable | undefined)[] =
        a.yields;
      if (isGenerator(k)) kidGen = k;
      else if (isTransduced(k)) {
        kidGen = k.gen;
        kidTicks = composeStack(a.ticks, k.ticks);
        kidResumes = composeStack(a.resumes, k.resumes);
        kidYields = composeStack(a.yields, k.yields);
      } else kidGen = asGen(k);
      children.push(
        this.spawn(
          kidGen,
          a,
          (value, error) => {
            if (aborted) return;
            if (error !== undefined) return settle(error, true, true);
            if (isCut(value))
              return settle((value as Cut<unknown>)[CUT_KEY], false, true);
            results[idx] = value;
            if (--left === 0) settle(results, false, false);
          },
          kidTicks,
          kidResumes,
          kidYields,
        ),
      );
    }
  }
}

// ─── Internal ────────────────────────────────────────────────────────

const DEAD = -Infinity;
const READY = 0;
const PARKED = Infinity;

const CUT_KEY = Symbol("cut");

// One frozen empty array, shared by every non-using slot. `readonly never[]`
// is assignable to `readonly T[]` for any T, so the same constant works for
// all three stack types.
const EMPTY: readonly never[] = Object.freeze([]);

type Wake<T = void> = ([T] extends [void] ? () => void : (value: T) => void) & {
  throw(error: unknown): void;
};

type OnSettle = (value: unknown, error: unknown) => void;

const isCut = (v: unknown): v is Cut<unknown> =>
  v !== null && typeof v === "object" && CUT_KEY in (v as object);

const unwrapCut = (v: unknown): unknown =>
  isCut(v) ? (v as Cut<unknown>)[CUT_KEY] : v;

const isTransduced = (v: unknown): v is Transduced<any> =>
  typeof v === "object" && v !== null && TRANSDUCE_KEY in (v as object);

// Cached generator-function prototype for the runtime guard in `start`.
const GENERATOR_FUNCTION_PROTO = Object.getPrototypeOf(function* () {});
const isGeneratorFunction = (v: unknown): boolean =>
  typeof v === "function" && Object.getPrototypeOf(v) === GENERATOR_FUNCTION_PROTO;

const pushStack = <T>(t: T | undefined, stack: readonly T[]): readonly T[] =>
  t === undefined ? stack : [t, ...stack];

const composeStack = <T>(
  parent: readonly T[],
  child: readonly T[],
): readonly T[] =>
  parent.length === 0
    ? child
    : child.length === 0
      ? parent
      : [...parent, ...child];

class Active {
  /** READY (0) | PARKED (Inf) | DEAD (-Inf) | positive sleep target (in localClock units). */
  wakeAt = READY;
  /** Subjective clock — advances by Σ ticks[i](dt) each step.
   *  For non-transduced actives this equals engine clock. */
  localClock = 0;
  /** Per-hook stacks. Shared `EMPTY` for non-using slots → zero per-step
   *  cost (loop never enters). Outermost-first storage; `onTick` walks
   *  reverse, `onResume`/`onYield` walk forward. */
  ticks: readonly ((dt: number) => number)[] = EMPTY;
  resumes: readonly ((tick: Tick) => Tick | undefined)[] = EMPTY;
  yields: readonly ((v: Yieldable) => Yieldable | undefined)[] = EMPTY;
  cleanup: (() => void) | null = null;
  onSettle: OnSettle | null = null;
  /** Cancel-during-advance defers gen.return() to the finally. */
  busy = false;
  pendingReturn = false;
  constructor(readonly gen: Animator<any>) {}
}

function* asGen(y: Yieldable): Animator<any> {
  yield y;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (typeof v !== "object") return String(v);
  return (
    (v as { constructor?: { name?: string } }).constructor?.name ?? "object"
  );
}
