//   Yield contract:
//   undefined       park 1 frame
//   number > 0      sleep N (subjective) seconds
//   Animator        spawn child, await its return value
//   Yieldable[]     run concurrently; resume with results[]
//   Suspend         callback-wake `(wake, spawn) => dispose`
//   Transduced      spawn `gen` with attached transducer stack
//
//   Resume values are either:
//   Tick, a { dt: number, elapsed: number } object
//   Example: `const { dt } = yield;`
//
//   T (generic), if the suspend is `(wake, spawn) => T`
//   Example: `const result = yield (wake, spawn) => { ... }`

const DEAD = -Infinity;
const READY = 0;
const PARKED = Infinity;

const CUT_KEY = Symbol("cut");
export type Cut<T> = { readonly [CUT_KEY]: T };
export const cut = <T>(value: T): Cut<T> => ({ [CUT_KEY]: value });
const isCut = (v: unknown): v is Cut<unknown> =>
  v !== null && typeof v === "object" && CUT_KEY in (v as object);
const unwrapCut = (v: unknown): unknown =>
  isCut(v) ? (v as Cut<unknown>)[CUT_KEY] : v;

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

type Wake<T = void> = ([T] extends [void] ? () => void : (value: T) => void) & {
  throw(error: unknown): void;
};

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

const isGen = (v: unknown): v is Animator =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { next?: unknown }).next === "function";

function* asGen(y: Yieldable): Animator<any> {
  yield y;
}

export const TRANSDUCE_KEY = Symbol("transduce");

export interface Transducer {
  /** gen → engine direction: transform an outgoing yield. */
  onYield?(v: Yieldable): Yieldable | undefined;
  /** engine → gen direction: transform an incoming resume payload (on wake). */
  onResume?(tick: Tick): Tick | undefined;
  /** engine internal: per-step time advancement. Return 0 to freeze the
   *  active for this frame (no localClock advance, no wake check). */
  onTick?(dt: number): number;
}

/** Generator + transducer stack. The symbol is just a marker; the engine
 *  reads `gen`/`trans` directly. `R` is the wrapped gen's return type —
 *  recoverable via `Resume<Transduced<R>>`. Outermost-first: engine walks
 *  innermost→outermost for `onTick` (descendants see scaled dt first);
 *  outermost→innermost for `onResume` (gen sees outermost last). */
export interface Transduced<R = unknown> {
  readonly [TRANSDUCE_KEY]: true;
  readonly gen: Animator<R>;
  readonly trans: readonly Transducer[];
}

const isTransduced = (v: unknown): v is Transduced<any> =>
  typeof v === "object" && v !== null && TRANSDUCE_KEY in (v as object);

/** Stack `t` on top of `target`. Pushes onto the list — no eager fusion.
 *  Preserves the wrapped gen's return type through composition. */
export function transduce<R>(
  t: Transducer,
  target: Animator<R> | Transduced<R>,
): Transduced<R> {
  if (isTransduced(target)) {
    return {
      [TRANSDUCE_KEY]: true,
      gen: target.gen as Animator<R>,
      trans: [t, ...target.trans],
    };
  }
  return { [TRANSDUCE_KEY]: true, gen: target, trans: [t] };
}

type OnSettle = (value: unknown, error: unknown) => void;

const EMPTY: readonly Transducer[] = Object.freeze([]);

class Active {
  /** READY (0) | PARKED (Inf) | DEAD (-Inf) | positive sleep target (in localClock units). */
  wakeAt = READY;
  /** Subjective clock — advances by Σ trans[i].onTick(dt) each step.
   *  For transducer-free actives this equals engine clock. */
  localClock = 0;
  /** Outermost-first list. Empty (frozen, shared) for non-transduced. */
  trans: readonly Transducer[] = EMPTY;
  cleanup: (() => void) | null = null;
  onSettle: OnSettle | null = null;
  /** Cancel-during-advance defers gen.return() to the finally. */
  busy = false;
  pendingReturn = false;
  constructor(readonly gen: Animator<any>) {}
}

export class Anim {
  protected actives: Active[] = [];
  private deads = 0;
  /** Re-entry guard: true while `step()` is iterating. Calling `step()`
   *  again from inside a transducer hook or a gen body throws. Other ops
   *  (start, stop, cancel) remain legal from inside step — they only
   *  mutate `actives`, which the loop handles via index + skip-checks. */
  private stepping = false;

  onError: (e: unknown) => void = (e) => {
    console.error("minim:", e);
  };

  #clock = 0;
  get clock(): number {
    return this.#clock;
  }

  start(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(asAnimator(g), null, null, EMPTY);
    return () => this.cancel(a);
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
  }

  private stepInner(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.#clock += dt;

    const as = this.actives;
    const alen = as.length;
    const d0 = this.deads;
    for (let i = 0; i < alen; i++) {
      const a = as[i];
      if (!a || a.wakeAt === DEAD || a.wakeAt === PARKED) continue;

      // Per-active time advance. `onTick` always fires (even at dt=0) so
      // observation-style transducers (trace, stats) see every step. The
      // freeze guard only triggers when there was real time to consume
      // (dt > 0) and the transducer chain ate it all (subjDt === 0).
      const trans = a.trans;
      let subjDt = dt;
      for (let k = trans.length - 1; k >= 0; k--) {
        const ot = trans[k].onTick;
        if (ot) subjDt = ot(subjDt);
      }
      if (dt > 0 && subjDt === 0) continue; // frozen by transducer
      if (subjDt > 0) a.localClock += subjDt;

      if (a.wakeAt <= a.localClock) {
        const saved = a.wakeAt;
        a.wakeAt = READY;
        // Sub-frame: only the time since the wake threshold is "owed".
        const dtEff =
          saved > 0 ? Math.min(subjDt, a.localClock - saved) : subjDt;
        let tick: Tick = { dt: dtEff, elapsed: a.localClock };
        // onResume runs only at wake-time. Outer-to-inner (gen sees outer last).
        for (let k = 0; k < trans.length; k++) {
          const or = trans[k].onResume;
          if (or) tick = or(tick) ?? tick;
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
    trans: readonly Transducer[],
  ): Active {
    const a = new Active(gen);
    a.onSettle = onSettle;
    a.trans = trans;
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

        // onYield chain: outer-to-inner (outer sees gen yield last).
        const trans = a.trans;
        for (let k = 0; k < trans.length; k++) {
          const oy = trans[k].onYield;
          if (oy) {
            const m = oy(v);
            if (m !== undefined) v = m;
          }
        }

        if (v === undefined) return; // park 1 frame
        if (typeof v === "number") {
          // `yield N <= 0` parks (semantic alignment with `yield`).
          if (v > 0) a.wakeAt = a.localClock + v;
          return;
        }
        if (typeof v === "function") return this.suspend(a, v as Suspend<any>);
        if (Array.isArray(v)) return this.concurrent(a, v);
        if (isGen(v)) return this.awaitChild(a, v, a.trans);
        if (isTransduced(v)) {
          return this.awaitChild(a, v.gen, composeTrans(a.trans, v.trans));
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
      const child = this.spawn(g, null, null, EMPTY);
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

  /** Park `a` and spawn `gen` as its child with the given transducer stack;
   *  resume `a` with the child's return value (or error) on settle. */
  private awaitChild(
    a: Active,
    gen: Animator,
    trans: readonly Transducer[],
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
      trans,
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
      let kidTrans: readonly Transducer[] = a.trans;
      if (isGen(k)) kidGen = k;
      else if (isTransduced(k)) {
        kidGen = k.gen;
        kidTrans = composeTrans(a.trans, k.trans);
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
          kidTrans,
        ),
      );
    }
  }
}

function asAnimator<R>(g: Animator<R> | (() => Animator<R>)): Animator<R> {
  return typeof g === "function" ? g() : g;
}

const composeTrans = (
  parent: readonly Transducer[],
  child: readonly Transducer[],
): readonly Transducer[] =>
  parent.length === 0 ? child : [...parent, ...child];

function describe(v: unknown): string {
  if (v === null) return "null";
  if (typeof v !== "object") return String(v);
  return (
    (v as { constructor?: { name?: string } }).constructor?.name ?? "object"
  );
}
