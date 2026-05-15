// minim animation runtime — small, fast, plain JS generators.
//
// Yield contract (same as today):
//   undefined        → park one frame; resume with dt
//   number > 0       → sleep N seconds; resume with dt
//   number ≤ 0       → tail-call (resume immediately, no frame consumed)
//   Animator<R>      → spawn child; resume with R when it completes
//   Yieldable[]      → spawn all in parallel; resume when all complete
//   SuspendFn<T>     → callback-driven wake; resume with T
//
// Suspensions get a `runtime` arg with `onFrame(cb)` for per-frame
// callbacks that bypass per-frame `gen.next()`. `drive()` uses it —
// that's why hot inner loops aren't generator-overhead-bound.
//
// What's NOT in the runtime (was in core/anim.ts; now userland):
//   per-Active time scale → mapDt(fn, gen)
//   observer / lifecycle  → tap-style wrapper
//   clock listeners       → suspend that registers an onFrame
//
// 130 lines of code. ≈ v21 perf without v21's per-Active scale
// machinery, observer hooks, or clock-listener plumbing.

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  rt: { onFrame(cb: (dt: number, t: number) => void): () => void },
) => () => void;

export type Yieldable =
  | number
  | undefined
  | Animator<any>
  | Yieldable[]
  | SuspendFn<any>;
export type Animator<R = void> = Generator<Yieldable, R, number>;

/** Construct a one-shot suspension generator: `yield* suspend(impl)`
 *  resumes with the value `wake(value)` was called with. */
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

const isGen = (v: any): v is Animator<any> =>
  v != null && typeof v === "object" && typeof v.next === "function";

class Active {
  // wakeAt: 0 ready · >0 sleeping (vs engine clock) · Infinity parked.
  wakeAt = 0;
  dispose: (() => void) | null = null;
  onDone: ((v: unknown) => void) | null = null;
  kids: Active[] | null = null;
  done = false;
  busy = false; // re-entrancy guard: cancel during advance() defers .return()
  pendingReturn = false;
  constructor(readonly gen: Animator<any>, readonly par: Active | null) {}
}

// Ticker carries its own `t` accumulator so user `drive(cb)` doesn't
// need a closure variable. `alive=false` is a tombstone for in-place
// removal during the step loop.
class Ticker {
  alive = true;
  t = 0;
  constructor(readonly cb: (dt: number, t: number) => void) {}
}

export class Anim {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  // Lazy compaction: bumped on each death; step compacts only when
  // it changed within the frame. Steady-state has no compaction work.
  private deadSeen = 0;
  clock = 0;

  run(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof g === "function" ? g() : g, null);
    return () => this.cancel(a);
  }

  stop(): void {
    for (const a of this.actives.slice()) this.cancel(a);
    this.actives.length = 0;
    this.tickers.length = 0;
    this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    // Tickers — the hot path. No generator overhead per tick.
    const ts = this.tickers;
    if (ts.length > 0) {
      let tw = 0;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (!t.alive) continue;
        t.t += dt;
        try { t.cb(dt, t.t); } catch (e) { console.error("minim:", e); t.alive = false; continue; }
        if (!t.alive) continue;
        if (i !== tw) ts[tw] = t;
        tw++;
      }
      ts.length = tw;
    }
    // Actives — wake sleepers, advance ready ones. Most are parked.
    // Lazy compaction: only walk to remove dead entries when something
    // actually died this step.
    const arr = this.actives;
    const len = arr.length;
    const deadBefore = this.deadSeen;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (!a.done && a.wakeAt <= this.clock) {
        a.wakeAt = 0;
        this.advance(a, dt);
      }
    }
    if (this.deadSeen !== deadBefore) {
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (!a.done) { if (i !== w) arr[w] = a; w++; }
      }
      arr.length = w;
    }
  }

  private spawn(g: Animator<any>, par: Active | null, onDone?: (v: unknown) => void): Active {
    const a = new Active(g, par);
    if (onDone) a.onDone = onDone;
    if (par) (par.kids ??= []).push(a);
    this.actives.push(a);
    this.advance(a, undefined);
    return a;
  }

  private cancel(a: Active): void {
    if (a.done) return;
    a.done = true;
    this.deadSeen++;
    const d = a.dispose; a.dispose = null;
    if (d) d();
    if (a.par?.kids) {
      const i = a.par.kids.indexOf(a);
      if (i >= 0) a.par.kids.splice(i, 1);
    }
    if (a.kids) {
      const cs = a.kids; a.kids = null;
      for (let i = 0; i < cs.length; i++) if (!cs[i].done) this.cancel(cs[i]);
    }
    if (a.busy) { a.pendingReturn = true; return; }
    a.gen.return(undefined);
  }

  private advance(a: Active, resume: unknown): void {
    a.busy = true;
    try {
      let r = a.gen.next(resume as any);
      while (!r.done) {
        if (a.done) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = this.clock + v; return; }
          r = a.gen.next(0); continue;
        }
        if (typeof v === "function") return this.subscribe(a, v as SuspendFn<any>);
        return this.spawnKids(a, Array.isArray(v) ? v : [v]);
      }
      if (a.done) return;
      a.done = true;
      this.deadSeen++;
      if (a.par?.kids) {
        const i = a.par.kids.indexOf(a);
        if (i >= 0) a.par.kids.splice(i, 1);
      }
      const cb = a.onDone; a.onDone = null;
      if (cb) cb(r.value);
    } catch (e) {
      console.error("minim:", e);
      if (!a.done) { a.done = true; this.deadSeen++; }
    } finally {
      a.busy = false;
      if (a.pendingReturn) { a.pendingReturn = false; a.gen.return(undefined); }
    }
  }

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const wake = (val?: unknown): void => {
      if (resumed || a.done) return;
      resumed = true;
      const d = a.dispose; a.dispose = null;
      a.wakeAt = 0;
      if (d) d();
      this.advance(a, val);
    };
    const onFrame = (cb: (dt: number, t: number) => void): (() => void) => {
      const t = new Ticker(cb);
      this.tickers.push(t);
      return () => { t.alive = false; };
    };
    const dispose = impl(wake, { onFrame });
    if (resumed || a.done) dispose();
    else { a.wakeAt = Infinity; a.dispose = dispose; }
  }

  private spawnKids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, undefined);
    let left = kids.length;
    a.wakeAt = Infinity;
    const onChild = (): void => {
      if (--left === 0 && a.wakeAt === Infinity && !a.done) {
        a.wakeAt = 0;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.done) return;
      const k = kids[j];
      this.spawn(isGen(k) ? k : (function* () { yield k as any; })(), a, onChild);
    }
  }
}

/** Tick `step(dt, t)` each frame. Return `false` to complete. Skips
 *  per-frame `gen.next()` by registering on the runtime ticker. */
export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, rt) =>
    rt.onFrame((dt, t) => {
      if (step(dt, t) === false) wake();
    }),
  );
}
