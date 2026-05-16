// v7b: v7 with class-based markers for Race/Frame instead of plain
//      objects with discriminator keys. `instanceof` is monomorphic-
//      friendly for V8; .race/.frame property probes on Generator
//      yields polluted advance()'s ICs in v7.
//
// Three observations from a survey of in-tree `suspend()` usage:
//
//   * 9 of 13 production suspend-fns use ONLY `wake` — the 3-arg
//     `(wake, spawn, anim)` signature is bureaucracy for them.
//   * The 4 power-users (withTimeout, all, race, every) all need
//     either `spawn` (for race-like cancellation) or `onFrame` (for
//     frame-driven side-effects). These are two distinct capabilities
//     conflated under "SuspendFn ctx".
//   * `every` ignores `wake` entirely — it's a pure per-frame
//     side-effect, not a wakeable suspend.
//
// v7's response:
//
//   1. `SuspendFn` becomes 1-arg: `(wake) => disposer`. No more
//      `spawn` / `anim` parameters. Drops 8 lines from subscribe().
//
//   2. Two new built-in yieldables cover the power-user gap:
//
//        yield { race: [a, b, ...] }
//            First-completion race; losers cascade-cancel; resume
//            with winner's value. Replaces both `race()` from
//            `suspensions.ts` and `withTimeout` (`{race: [g, n]}`).
//
//        yield { frame: (dt, t) => boolean | void }
//            Per-frame callback; resume when cb returns `false`.
//            Replaces both `drive()` and `every()`. Cleaner than
//            "build a SuspendFn that calls anim.onFrame".
//
//   3. Cancel-with-reason: the disposer accepts an optional `reason`;
//      when supplied, the active is torn down via `gen.throw(reason)`
//      instead of `gen.return()`. Lets user `try { yield } catch(e)`
//      distinguish "cancelled" from "timed out" from "natural end".
//
//   4. `Symbol.dispose` on the run handle (carried over from v5).
//
// Everything carries v6's correctness: model-a errors, settle()
// unification, setup-window guard for back-compat (now gone since
// spawn is gone — but kept as a no-op concept for race kids).

export type Yieldable =
  | number | undefined | Animator<any> | Yieldable[] | SuspendFn<any>
  | PromiseLike<any> | RaceSpec | FrameSpec;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type PayloadOf<Y> =
  Y extends Animator<infer R> ? R
  : Y extends SuspendFn<infer R> ? R
  : Y extends PromiseLike<infer R> ? R
  : void;

/** Simple suspend: park until `wake(value)`. Returns a disposer. */
export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
) => () => void;

/** First-completion race; losers cascade-cancel on first settle. */
export class RaceSpec { constructor(readonly kids: readonly Yieldable[]) {} }

/** Per-frame callback; completes when `cb` returns `false`. */
export class FrameSpec { constructor(readonly cb: (dt: number, t: number) => boolean | void) {} }

const DEAD = -1, READY = 0, PARKED = Infinity;

/** Park until wake. `yield* suspend(impl)` ≡ `yield impl` then return T. */
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

/** Race convenience constructor. */
export const race = <Cs extends readonly Yieldable[]>(...kids: Cs): RaceSpec =>
  new RaceSpec(kids);

/** Frame-driven loop; completes when `cb` returns `false`. */
export const drive = (cb: (dt: number, t: number) => boolean | void): FrameSpec =>
  new FrameSpec(cb);

export const isGen = (v: any): v is Animator<any> =>
  typeof v?.next === "function";

const isThenable = (v: any): v is PromiseLike<any> =>
  typeof v?.then === "function";

function* asGen(y: Yieldable): Animator<any> { yield y; }

export interface AnimObserver {
  spawn?(id: number, parentId: number | undefined, clock: number, gen: Animator<any>): void;
  complete?(id: number, clock: number, value?: unknown): void;
  cancel?(id: number, clock: number): void;
  error?(id: number, clock: number, err: unknown): void;
}

class Active {
  wakeAt = READY;
  cleanup: (() => void) | null = null;
  onDone: ((v: any, idx: number, err: unknown) => void) | null = null;
  kidIdx = 0;
  busy = false; pendingReturn = false; observeId = 0;
  /** Set when cancel was called with a reason; used in finally to
   *  choose between gen.throw(reason) and gen.return(). */
  cancelReason: unknown = undefined;
  cancelWithReason = false;
  constructor(readonly gen: Animator<any>) {}
}

class Ticker {
  alive = true; t0 = 0;
  constructor(readonly cb: (dt: number, t: number) => void) {}
}

function safeTick(t: Ticker, dt: number, time: number, onErr: (e: unknown) => void): void {
  try { t.cb(dt, time); } catch (e) { onErr(e); t.alive = false; }
}

/** Callable disposer (compat) with `[Symbol.dispose]` for `using`,
 *  accepting an optional `reason` that propagates via `gen.throw`. */
export interface RunHandle {
  (reason?: unknown): void;
  [Symbol.dispose](): void;
}

export class Anim {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  private deadSeen = 0;
  private nextObserveId = 0;
  observer: AnimObserver | undefined;
  onError: (err: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  run(g: Animator<any> | (() => Animator<any>)): RunHandle {
    const a = this.spawn(typeof g === "function" ? g() : g, null);
    const dispose = (reason?: unknown): void => this.cancel(a, reason);
    (dispose as any)[Symbol.dispose] = () => this.cancel(a, undefined);
    return dispose as RunHandle;
  }

  stop(): void {
    for (const a of this.actives) this.cancel(a, undefined);
    this.actives.length = 0;
    this.tickers.length = 0;
    this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const clock = this.clock;

    const ts = this.tickers, onErr = this.onError;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      safeTick(t, dt, clock - t.t0, onErr);
      if (t.alive) ts[tw++] = t;
    }
    ts.length = tw;

    const arr = this.actives, len = arr.length, dead0 = this.deadSeen;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (a.wakeAt !== DEAD && a.wakeAt <= clock) {
        a.wakeAt = READY;
        this.advance(a, dt);
      }
    }
    if (this.deadSeen !== dead0) {
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].wakeAt !== DEAD) arr[w++] = arr[i];
      }
      arr.length = w;
    }
  }

  /** Register a per-frame callback. Returns a disposer. Kept as a
   *  public method for back-compat and as an escape hatch; inside
   *  generators prefer `yield { frame: cb }`. */
  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t = new Ticker(cb);
    t.t0 = this.clock;
    this.tickers.push(t);
    return () => { t.alive = false; };
  }

  private spawn(
    g: Animator<any>, parent: Active | null,
    onDone: ((v: any, idx: number, err: unknown) => void) | null = null,
  ): Active {
    const a = new Active(g);
    a.onDone = onDone;
    this.actives.push(a);
    if (this.observer) {
      a.observeId = ++this.nextObserveId;
      this.observer.spawn?.(a.observeId, parent?.observeId || undefined, this.clock, g);
    }
    this.advance(a, undefined);
    return a;
  }

  private cancel(a: Active, reason: unknown): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.deadSeen++;
    this.observer?.cancel?.(a.observeId, this.clock);
    const c = a.cleanup; a.cleanup = null; a.onDone = null;
    if (c) c();
    if (reason !== undefined) {
      a.cancelWithReason = true;
      a.cancelReason = reason;
    }
    if (a.busy) { a.pendingReturn = true; return; }
    try {
      if (a.cancelWithReason) a.gen.throw(a.cancelReason);
      else a.gen.return(undefined);
    } catch (e) { this.onError(e); }
  }

  private settle(a: Active, value: unknown, errored: boolean, err: unknown): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.deadSeen++;
    if (errored) this.observer?.error?.(a.observeId, this.clock, err);
    else this.observer?.complete?.(a.observeId, this.clock, value);
    const cb = a.onDone; a.onDone = null;
    if (cb) cb(errored ? undefined : value, a.kidIdx, errored ? err : undefined);
    else if (errored) this.onError(err);
  }

  private advance(a: Active, resume: any, asThrow = false): void {
    a.busy = true;
    try {
      let r = asThrow ? a.gen.throw(resume) : a.gen.next(resume);
      while (!r.done) {
        if (a.wakeAt === DEAD) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = this.clock + v; return; }
          r = a.gen.next(0); continue;
        }
        if (typeof v === "function") return this.subscribe(a, v as SuspendFn<any>);
        if (Array.isArray(v)) return this.spawnKids(a, v);
        if (v instanceof RaceSpec) return this.spawnRace(a, v.kids);
        if (v instanceof FrameSpec) return this.subscribeFrame(a, v.cb);
        if (isThenable(v)) return this.subscribePromise(a, v);
        return this.spawnOne(a, v as Animator<any>);
      }
      this.settle(a, r.value, false, undefined);
    } catch (e) {
      this.settle(a, undefined, true, e);
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try {
          if (a.cancelWithReason) a.gen.throw(a.cancelReason);
          else a.gen.return(undefined);
        } catch (e) { this.onError(e); }
      }
    }
  }

  /** Simple 1-arg suspend. No spawn, no anim — those needs are
   *  served by yield-array, race, frame, and Promise. */
  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const wake = (val?: any): void => {
      if (resumed || a.wakeAt === DEAD) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = READY;
      if (c) c();
      this.advance(a, val);
    };

    const userDispose = impl(wake);

    if (resumed || a.wakeAt === DEAD) {
      try { userDispose(); } catch (e) { this.onError(e); }
    } else {
      a.wakeAt = PARKED;
      a.cleanup = userDispose;
    }
  }

  private subscribePromise(a: Active, p: PromiseLike<any>): void {
    let cancelled = false;
    a.wakeAt = PARKED;
    a.cleanup = (): void => { cancelled = true; };
    p.then(
      (v: any) => {
        if (cancelled || a.wakeAt === DEAD) return;
        a.cleanup = null; a.wakeAt = READY;
        this.advance(a, v);
      },
      (e: any) => {
        if (cancelled || a.wakeAt === DEAD) return;
        a.cleanup = null; a.wakeAt = READY;
        this.advance(a, e, true);
      },
    );
  }

  /** Built-in frame-driven loop. `yield { frame: cb }` registers
   *  cb as an onFrame ticker; completes when cb returns false. */
  private subscribeFrame(
    a: Active,
    cb: (dt: number, t: number) => boolean | void,
  ): void {
    a.wakeAt = PARKED;
    const stop = this.onFrame((dt, t) => {
      if (cb(dt, t) === false && a.wakeAt === PARKED && a.cleanup !== null) {
        const c = a.cleanup; a.cleanup = null;
        a.wakeAt = READY;
        c();  // dispose ticker BEFORE advance to avoid stale firings
        this.advance(a, undefined);
      }
    });
    a.cleanup = stop;
  }

  /** Built-in race. First settle wins; losers cascade-cancel. */
  private spawnRace(a: Active, kids: readonly Yieldable[]): void {
    if (kids.length === 0) {
      // Empty race never completes — match the rest of the protocol's
      // "yield [] resumes immediately" by resuming with undefined.
      return this.advance(a, undefined);
    }
    const children: Active[] = [];
    let won = false;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c, undefined);
    };
    const onKid = (v: any, _idx: number, err: unknown): void => {
      if (won || a.cleanup === null || a.wakeAt === DEAD) return;
      won = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = READY;
      if (c) c();
      if (err !== undefined) this.advance(a, err, true);
      else this.advance(a, v);
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt === DEAD || won) return;
      const k = kids[j];
      const child = this.spawn(isGen(k) ? k : asGen(k), a, onKid);
      children.push(child);
    }
  }

  private spawnOne(a: Active, child: Animator<any>): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== DEAD) this.cancel(c, undefined); };
    c = this.spawn(child, a, (v: any, _idx: number, err: unknown) => {
      if (a.wakeAt === PARKED && a.cleanup !== null) {
        a.cleanup = null;
        a.wakeAt = READY;
        if (err !== undefined) this.advance(a, err, true);
        else this.advance(a, v);
      }
    });
  }

  private spawnKids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, []);
    const children: Active[] = [];
    const results: any[] = new Array(kids.length);
    let left = kids.length;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c, undefined);
    };
    const onChild = (v: any, idx: number, err: unknown): void => {
      if (err !== undefined && a.cleanup !== null && a.wakeAt !== DEAD) {
        const c = a.cleanup; a.cleanup = null;
        a.wakeAt = READY;
        if (c) c();
        this.advance(a, err, true);
        return;
      }
      results[idx] = v;
      if (--left === 0 && a.cleanup !== null && a.wakeAt !== DEAD) {
        a.cleanup = null;
        a.wakeAt = READY;
        this.advance(a, results);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt === DEAD) return;
      const k = kids[j];
      const child = this.spawn(isGen(k) ? k : asGen(k), a, onChild);
      child.kidIdx = j;
      children.push(child);
    }
  }
}
