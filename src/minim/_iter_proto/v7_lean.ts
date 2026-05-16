// v7_lean: v4-shape with everything that doesn't earn its LoC removed.
//
// Yield contract (unchanged from v4 at the user-visible level, +Promise):
//   undefined        park 1 frame; resume with dt
//   number > 0       sleep N seconds
//   number ≤ 0       sync tail-call
//   Animator         spawn child; resume with R when it completes
//   Yieldable[]      spawn all in parallel; resume with [R0, R1, …]
//   Effect<T>        callback wake; resume with T  (was SuspendFn)
//   PromiseLike<T>   await; resume with T          (new sugar)
//
// `Effect<T> = (wake, anim) => dispose` is the lone universal shape;
// `SuspendFn` is gone (it was the same shape with a 3rd `spawn` arg
// nobody used heavily — if you need to spawn from inside an Effect,
// call `anim.run(g)` directly and add its disposer to the one you
// return).
//
// Dropped vs v4:
//   • AnimObserver + observeId machinery        (~30 LoC)
//   • SuspendFn `spawn` arg + setup-window guard (~20 LoC)
//   • sub-kids tracking inside subscribe         (~15 LoC)
//   • spawnOne / spawnKids divergence in helpers (folded; the array
//     branch handles len==0 / len==1 cheaply)    (~10 LoC)
//
// Kept (load-bearing for v4-perf parity):
//   • Active class with wakeAt sentinel state machine
//   • Ticker fast path for `drive(cb)` (bypasses gen.next per frame)
//   • Hoisted safeTick to keep the tick loop catch-free for V8
//   • busy/pendingReturn re-entrancy for cancel-during-advance
//
// Result: ~140 LoC engine + ~50 LoC stdlib. Bench target: parity.

export type Yieldable<T = any> =
  | undefined | number
  | Animator<T> | Yieldable<T>[]
  | Effect<T> | PromiseLike<T>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type Effect<T = void> = (wake: (v: T) => void, anim: Anim) => () => void;

const DEAD = -1, READY = 0, PARKED = Infinity;
const isGen = (v: any): v is Animator<any> => typeof v?.next === "function";
const isThenable = (v: any): v is PromiseLike<any> =>
  v !== null && typeof v === "object" && typeof v.then === "function";
function* asGen(y: Yieldable): Animator<any> { return yield y; }

class Active {
  wakeAt = READY;
  cleanup: (() => void) | null = null;
  onDone: ((v: any) => void) | null = null;
  busy = false; pendingReturn = false;
  constructor(readonly gen: Animator<any>) {}
}

interface Ticker { cb: (dt: number, t: number) => void; t0: number; alive: boolean; }
function safeTick(t: Ticker, dt: number, time: number, onErr: (e: unknown) => void): void {
  try { t.cb(dt, time); } catch (e) { onErr(e); t.alive = false; }
}

export class Anim {
  private as: Active[] = [];
  private ts: Ticker[] = [];
  private dead = 0;
  onError: (e: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  run<R>(g: Animator<R> | (() => Animator<R>), onDone?: (v: R) => void): () => void {
    const a = this.sp(typeof g === "function" ? g() : g, (onDone ?? null) as any);
    return () => this.cx(a);
  }

  stop(): void {
    for (const a of this.as) this.cx(a);
    this.as.length = 0; this.ts.length = 0; this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const c = this.clock, ts = this.ts, onErr = this.onError;
    let w = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]; if (!t.alive) continue;
      safeTick(t, dt, c - t.t0, onErr);
      if (t.alive) ts[w++] = t;
    }
    ts.length = w;
    const as = this.as, len = as.length, d0 = this.dead;
    for (let i = 0; i < len; i++) {
      const a = as[i];
      if (a.wakeAt !== DEAD && a.wakeAt <= c) { a.wakeAt = READY; this.adv(a, dt); }
    }
    if (this.dead !== d0) {
      let cw = 0;
      for (let i = 0; i < as.length; i++) if (as[i].wakeAt !== DEAD) as[cw++] = as[i];
      as.length = cw;
    }
  }

  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t: Ticker = { cb, t0: this.clock, alive: true };
    this.ts.push(t);
    return () => { t.alive = false; };
  }

  private sp(g: Animator<any>, onDone: ((v: any) => void) | null): Active {
    const a = new Active(g); a.onDone = onDone; this.as.push(a);
    this.adv(a, undefined);
    return a;
  }

  private cx(a: Active): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.dead++;
    const c = a.cleanup; a.cleanup = null; a.onDone = null;
    if (c) c();
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch (e) { this.onError(e); }
  }

  private settle(a: Active, value: unknown, errored: boolean, err: unknown): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.dead++;
    if (errored) this.onError(err);
    const cb = a.onDone; a.onDone = null;
    if (cb) cb(errored ? undefined : value);
  }

  private adv(a: Active, resume: any): void {
    a.busy = true;
    try {
      let r = a.gen.next(resume);
      while (!r.done) {
        if (a.wakeAt === DEAD) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = this.clock + v; return; }
          r = a.gen.next(0); continue;
        }
        if (typeof v === "function") return this.eff(a, v as Effect<any>);
        if (Array.isArray(v)) return this.kids(a, v);
        if (isThenable(v)) return this.thenable(a, v);
        return this.one(a, v as Animator<any>);
      }
      this.settle(a, r.value, false, undefined);
    } catch (e) {
      this.settle(a, undefined, true, e);
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try { a.gen.return(undefined); } catch (e) { this.onError(e); }
      }
    }
  }

  private eff(a: Active, impl: Effect<any>): void {
    let resumed = false;
    const wake = (val?: any): void => {
      if (resumed || a.wakeAt === DEAD) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = READY;
      if (c) c();
      this.adv(a, val);
    };
    const dispose = impl(wake, this);
    if (resumed || a.wakeAt === DEAD) {
      try { dispose(); } catch (e) { this.onError(e); }
    } else {
      a.wakeAt = PARKED;
      a.cleanup = dispose;
    }
  }

  private thenable(a: Active, p: PromiseLike<any>): void {
    a.wakeAt = PARKED;
    let settled = false;
    a.cleanup = () => { settled = true; };
    p.then(
      (v) => {
        if (settled || a.wakeAt === DEAD) return;
        settled = true; a.cleanup = null; a.wakeAt = READY;
        this.adv(a, v);
      },
      (e) => {
        if (settled || a.wakeAt === DEAD) return;
        settled = true; a.cleanup = null;
        this.settle(a, undefined, true, e);
      },
    );
  }

  private one(a: Active, child: Animator<any>): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== DEAD) this.cx(c); };
    c = this.sp(child, (v: any) => {
      if (a.wakeAt === PARKED && a.cleanup !== null) {
        a.cleanup = null; a.wakeAt = READY; this.adv(a, v);
      }
    });
  }

  private kids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.adv(a, []);
    const children: Active[] = [];
    const results: any[] = new Array(kids.length);
    let left = kids.length;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt !== DEAD) this.cx(c);
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt === DEAD) return;
      const k = kids[j], idx = j;
      children.push(this.sp(isGen(k) ? k : asGen(k), (v: any) => {
        results[idx] = v;
        if (--left === 0 && a.cleanup !== null && a.wakeAt !== DEAD) {
          a.cleanup = null; a.wakeAt = READY; this.adv(a, results);
        }
      }));
    }
  }
}

// ─────────────────────────── stdlib (userland) ───────────────────────────

/** Effect form: per-frame callback, complete by returning false. */
export const driveEffect = (cb: (dt: number, t: number) => boolean | void): Effect<void> =>
  (wake, anim) => anim.onFrame((dt, t) => { if (cb(dt, t) === false) wake(); });

/** Animator form so you can write `yield* drive(cb)` or `a.run(drive(cb))`. */
export function* drive(cb: (dt: number, t: number) => boolean | void): Animator<void> {
  yield driveEffect(cb);
}

/** Race; resume with first to settle. Cancels the rest. */
export const race = <T>(es: (Effect<T> | Animator<T> | PromiseLike<T>)[]): Effect<T> =>
  (wake, anim) => {
    let done = false;
    const ds = new Array<() => void>(es.length);
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      const cb = (v: T): void => {
        if (done) return;
        done = true;
        for (const d of ds) d?.();
        wake(v);
      };
      // Adapt non-Effect inputs to Effect shape.
      const eff: Effect<T> = typeof e === "function"
        ? (e as Effect<T>)
        : isGen(e)
          ? ((w, a) => a.run(e as any, w))
          : ((w) => { let live = true; (e as PromiseLike<T>).then((v) => live && w(v)); return () => { live = false; }; });
      ds[i] = eff(cb, anim);
      if (done) break;
    }
    return () => { done = true; for (const d of ds) d?.(); };
  };

/** Race vs an internal timeout. */
export const withTimeout = <T>(
  e: Effect<T> | Animator<T> | PromiseLike<T>, seconds: number,
): Effect<{ kind: "ok"; value: T } | { kind: "timeout" }> => (wake, anim) => {
  let done = false;
  const finish = (v: { kind: "ok"; value: T } | { kind: "timeout" }): void => {
    if (done) return; done = true; offTimer(); offE(); wake(v);
  };
  let offTimer = (): void => {};
  let offE = (): void => {};
  offTimer = anim.onFrame((dt) => {
    seconds -= dt;
    if (seconds <= 0) finish({ kind: "timeout" });
  });
  const adapt: Effect<T> = typeof e === "function"
    ? (e as Effect<T>)
    : isGen(e)
      ? ((w, a) => a.run(e as any, w))
      : ((w) => { let live = true; (e as PromiseLike<T>).then((v) => live && w(v)); return () => { live = false; }; });
  offE = adapt((v) => finish({ kind: "ok", value: v }), anim);
  return () => { done = true; offTimer(); offE(); };
};

/** Subscribe to an external event source; resume on first event. */
export const fromEvent = <T>(
  subscribe: (emit: (v: T) => void) => () => void,
): Effect<T> => (wake) => {
  let live = true;
  const off = subscribe((v) => { if (!live) return; live = false; off(); wake(v); });
  return () => { live = false; off(); };
};
