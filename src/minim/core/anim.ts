//   Yield contract:
//   undefined       park 1 frame
//   number > 0      sleep N seconds
//   Animator        spawn child, await its return value
//   Suspend         callback-wake `(wake, spawn) => dispose`
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
  | Suspend<any>;

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
      : void;

export type Cut<T> = { readonly [CUT_KEY]: T };

// ─── Public helpers ──────────────────────────────────────────────────

/** Cut sentinel — return `cut(v)` from a concurrent kid to settle the
 *  enclosing group with `v` and cancel siblings. Outside a group, the
 *  sentinel is transparently unwrapped to `v`. */
export const cut = <T>(value: T): Cut<T> => ({ [CUT_KEY]: value });

/** True if `v` is a Generator (duck-typed via `.next`). */
export const isGenerator = (v: unknown): v is Animator =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { next?: unknown }).next === "function";

// ─── Runtime ─────────────────────────────────────────────────────────

export class Anim {
  private actives: Active[] = [];
  private deads = 0;
  /** Re-entry guard: true while `step()` is iterating. Calling `step()`
   *  again from inside a gen body throws. Other ops (start, stop, cancel)
   *  remain legal from inside step — they only mutate `actives`, which
   *  the loop handles via index + skip-checks. */
  private stepping = false;
  private stepListeners: Set<(dt: number) => void> | null = null;
  private onError: (e: unknown) => void;

  #clock = 0;
  get clock(): number {
    return this.#clock;
  }

  constructor(opts: { onError?: (e: unknown) => void } = {}) {
    this.onError = opts.onError ?? ((e) => console.error("minim:", e));
  }

  /** Spawn one or more root-level actives. Each Animator becomes an
   *  independent active; the returned handle cancels all of them. Pass
   *  an array (`[a, b]`) inside a gen as a single Yieldable to spawn a
   *  concurrent group with cascading cancel + joined completion. */
  start(...gs: Animator<any>[]): () => void {
    if (gs.length === 0) return () => {};
    const actives = gs.map((g) => this.spawn(g, null, null));
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

      if (dt > 0) a.localClock += dt;

      if (a.wakeAt <= a.localClock) {
        const saved = a.wakeAt;
        a.wakeAt = READY;
        // Sub-frame: only the time since the wake threshold is "owed".
        const dtEff = saved > 0 ? Math.min(dt, a.localClock - saved) : dt;
        const tick: Tick = { dt: dtEff, elapsed: a.localClock };
        this.advance(a, tick, false);
      }
    }
    if (this.deads !== d0) this.compact();
  }

  private spawn(
    gen: Animator<any>,
    parent: Active | null,
    onSettle: OnSettle | null,
  ): Active {
    const a = new Active(gen);
    a.onSettle = onSettle;
    a.localClock = parent ? parent.localClock : 0;
    this.actives.push(a);
    this.advance(a, undefined, false);
    return a;
  }

  private cancel(a: Active): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD;
    this.deads++;
    const c = a.cleanup;
    a.cleanup = null;
    a.onSettle = null;
    this.safe(c);
    try {
      a.gen.return(undefined);
    } catch (e) {
      this.onError(e);
    }
  }

  private settle(
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
    try {
      let r = asThrow ? a.gen.throw(payload) : a.gen.next(payload);
      while (!r.done) {
        if (a.wakeAt === DEAD) return;
        const v = r.value;
        if (v === undefined) return; // park 1 frame
        if (typeof v === "number") {
          // `yield N <= 0` parks (semantic alignment with `yield`).
          if (v > 0) a.wakeAt = a.localClock + v;
          return;
        }
        if (typeof v === "function") return this.suspend(a, v as Suspend<any>);
        if (Array.isArray(v)) return this.concurrent(a, v);
        if (isGenerator(v)) return this.awaitChild(a, v);
        throw new TypeError(`anim: unsupported yield (${describe(v)})`);
      }
      this.settle(a, r.value, false, undefined);
    } catch (e) {
      this.settle(a, undefined, true, e);
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
      const child = this.spawn(g, null, null);
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

  /** Park `a` and spawn `gen` as its child; resume `a` with the
   *  child's return value (or error) on settle. */
  private awaitChild(a: Active, gen: Animator): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => {
      if (c && c.wakeAt !== DEAD) this.cancel(c);
    };
    c = this.spawn(gen, a, (v, err) => {
      if (a.wakeAt === DEAD || a.cleanup === null) return;
      a.cleanup = null;
      a.wakeAt = READY;
      this.advance(
        a,
        err === undefined ? unwrapCut(v) : err,
        err !== undefined,
      );
    });
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
      const kidGen = isGenerator(k) ? k : asGen(k);
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

type Wake<T = void> = ([T] extends [void] ? () => void : (value: T) => void) & {
  throw(error: unknown): void;
};

type OnSettle = (value: unknown, error: unknown) => void;

const isCut = (v: unknown): v is Cut<unknown> =>
  v !== null && typeof v === "object" && CUT_KEY in (v as object);

const unwrapCut = (v: unknown): unknown =>
  isCut(v) ? (v as Cut<unknown>)[CUT_KEY] : v;

class Active {
  /** READY (0) | PARKED (Inf) | DEAD (-Inf) | positive sleep target. */
  wakeAt = READY;
  /** Per-active subjective clock — advances by engine dt each step.
   *  Inherited from parent on spawn, then advances independently. */
  localClock = 0;
  cleanup: (() => void) | null = null;
  onSettle: OnSettle | null = null;
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
