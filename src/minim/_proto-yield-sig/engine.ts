// Minimal animator runtime, vendored from `core/anim.ts` for self-contained
// prototyping. Yield contract:
//   undefined   park 1 frame
//   number > 0  sleep N seconds
//   Animator    spawn child, await its return value
//   Yieldable[] run concurrently; resume with results[]
//   Suspend     callback-wake `(wake, spawn) => dispose`
//
// Resume value is `Tick` for bare `yield`, or the suspend's wake-payload
// for any of the object-shaped yields.

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
  // Any iterable whose iterator produces Yieldables — covers Signals
  // (via the `[Symbol.iterator]` method) and any user-defined opt-in.
  // Engine duck-types this via `isIterableYieldable` in dispatch.
  | { readonly [Symbol.iterator]: () => Iterator<Yieldable, any, any> };

export type Animator<R = void> = Generator<Yieldable, R, Tick>;

export type Wake<T = void> = ([T] extends [void]
  ? () => void
  : (value: T) => void) & {
  throw(error: unknown): void;
};

export type Suspend<T = void> = (
  wake: Wake<T>,
  spawn: (g: Animator<any>) => () => void,
) => void | (() => void);

export const isGenerator = (v: unknown): v is Animator =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { next?: unknown }).next === "function";

/** Anything that's `Symbol.iterator`-able — covers Signals (via the
 *  iterator method added in `signal.ts`) and any future custom Yieldable
 *  type that opts in. The engine treats these as if they were generators
 *  (we get a generator from `[Symbol.iterator]()`). */
export const isIterableYieldable = (v: unknown): boolean =>
  v !== null &&
  typeof v === "object" &&
  Symbol.iterator in (v as object) &&
  typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";

const DEAD = -Infinity;
const READY = 0;
const PARKED = Infinity;

type OnSettle = (value: unknown, error: unknown) => void;

class Active {
  wakeAt = READY;
  localClock = 0;
  cleanup: (() => void) | null = null;
  onSettle: OnSettle | null = null;
  constructor(readonly gen: Animator<any>) {}
}

export class Anim {
  private actives: Active[] = [];
  private deads = 0;
  private stepping = false;
  private onError: (e: unknown) => void;

  #clock = 0;
  get clock(): number {
    return this.#clock;
  }

  constructor(opts: { onError?: (e: unknown) => void } = {}) {
    this.onError = opts.onError ?? ((e) => console.error("minim:", e));
  }

  start(...gs: Animator<any>[]): () => void {
    if (gs.length === 0) return () => {};
    const actives = gs.map((g) => this.spawn(g, null, null));
    return () => {
      for (const a of actives) this.cancel(a);
    };
  }

  stop(): void {
    const snap = this.actives.slice();
    this.actives.length = 0;
    for (const a of snap) this.cancel(a);
  }

  step(dt: number): void {
    if (this.stepping) throw new Error("re-entrant step()");
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
      if (dt > 0) a.localClock += dt;
      if (a.wakeAt <= a.localClock) {
        const saved = a.wakeAt;
        a.wakeAt = READY;
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
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) a.wakeAt = a.localClock + v;
          return;
        }
        if (typeof v === "function") return this.suspend(a, v as Suspend<any>);
        if (Array.isArray(v)) return this.concurrent(a, v);
        if (isGenerator(v)) return this.awaitChild(a, v);
        if (isIterableYieldable(v)) {
          return this.awaitChild(
            a,
            (v as Iterable<Yieldable>)[Symbol.iterator]() as Animator,
          );
        }
        throw new TypeError(`unsupported yield: ${typeof v}`);
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
      finish(() => this.advance(a, v, false))) as Wake<any>;
    wake.throw = (e: unknown) => finish(() => this.advance(a, e, true));

    const spawnFn = (g: Animator): (() => void) => {
      const child = this.spawn(g, null, null);
      return () => this.cancel(child);
    };

    let dispose: (() => void) | undefined;
    try {
      dispose = impl(wake, spawnFn) ?? undefined;
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
      this.advance(a, v, err !== undefined);
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
      const kidGen: Animator<any> = isGenerator(k)
        ? k
        : isIterableYieldable(k)
          ? ((k as Iterable<Yieldable>)[Symbol.iterator]() as Animator)
          : asGen(k);
      children.push(
        this.spawn(kidGen, a, (value, error) => {
          if (aborted) return;
          if (error !== undefined) return settle(error, true, true);
          results[idx] = value;
          if (--left === 0) settle(results, false, false);
        }),
      );
    }
  }
}

function* asGen(y: Yieldable): Animator<any> {
  yield y;
}
