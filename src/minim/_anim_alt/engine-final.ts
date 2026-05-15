// engine-final — best-of-all.
//
// Synthesised from two parallel exploration streams. Production-ready
// shape; designed to replace `core/anim.ts`.
//
// Yield contract (unchanged from current):
//   undefined        → park 1 frame; resume with dt
//   number > 0       → sleep N seconds
//   number ≤ 0       → tail-call (resume immediately)
//   Animator<R>      → spawn child; resume with R when it completes
//   Yieldable[]      → spawn all in parallel; resume when all complete
//   SuspendFn<T>     → callback wake; resume with T
//
// SuspendFn signature: `(wake, spawn, rt) => dispose`.
//   • wake(value)         resume the host with `value`
//   • spawn(g, onDone)    spawn a child; cancellation cascades to the
//                         child via the host's cleanup; returns a
//                         disposer for explicit cancel
//   • rt.onFrame(cb)      register a per-frame callback that bypasses
//                         per-frame `gen.next()` overhead. Used by
//                         `drive()` for hot inner-loop work.
//
// Time-scale, observer hooks, clock listeners are NOT runtime concerns.
// Userland generator wrappers (`mapDt`, `tap`, etc) handle them.
//
// Lessons applied:
//   • Active is a real class — V8 deopts generator objects assigned
//     own fields (the "generator-as-active" experiment was 2× slower).
//   • Single `cleanup` slot does double duty — for SuspendFn it holds
//     the impl's disposer; for parallel-waiting parents it holds a
//     closure that cancels the kids. The two states never coexist.
//     Removes 2 fields (`dispose` + `kids`) and the entire `detach`
//     helper. Wins `parallel` by ~18% over the v31 design.
//   • Lazy compaction — `deadSeen` counter only walks the actives
//     array when something died this frame.
//   • try/catch around ticker `cb` — drive callbacks that throw must
//     not crash the whole step (regression test in the suite).
//   • Single `wakeAt` field encodes state: -1 done · 0 ready · >0
//     sleeping vs engine clock · Infinity parked.
//   • `busy` / `pendingReturn` re-entrancy guard for cancel-during-
//     advance (a SuspendFn impl that synchronously cancels the host).

const FRAME_CAP_MS = 32;

export interface RuntimeAccess {
  /** Register a per-frame callback. The callback receives `dt` (this
   *  frame's delta) and `t` (accumulated time since registration).
   *  Returns a disposer. */
  onFrame(cb: (dt: number, t: number) => void): () => void;
}

export type SpawnFn = <R>(
  g: Animator<R>,
  onDone?: (v: R) => void,
) => () => void;

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
  rt: RuntimeAccess,
) => () => void;

/** Construct a one-shot suspension generator. `yield* suspend(impl)`
 *  parks until `wake(value)` is called; resumes with `value`. */
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

export type Yieldable =
  | number
  | undefined
  | Animator<any>
  | Yieldable[]
  | SuspendFn<any>;
export type Animator<R = void> = Generator<Yieldable, R, number>;
export type PayloadOf<Y> =
  Y extends Animator<infer R> ? R
  : Y extends SuspendFn<infer R> ? R
  : void;

const isGen = (v: any): v is Animator<any> =>
  v != null && typeof v === "object" && typeof v.next === "function";

class Active {
  // wakeAt: -1 done · 0 ready · >0 sleeping vs engine clock · Infinity parked
  wakeAt = 0;
  // Single slot for "what to release when this active is cancelled or
  // wakes up". For a SuspendFn-parked active that's the impl's
  // disposer (wrapped to also cancel any spawned children). For a
  // parallel-waiting parent it's a closure that cancels its kids.
  cleanup: (() => void) | null = null;
  // Set when this active was spawned as a tracked child.
  onDone: ((v: any) => void) | null = null;
  // Re-entrancy guard for cancel-during-advance.
  busy = false;
  pendingReturn = false;
  // Convenience: track done state explicitly (clearer than wakeAt=-1
  // sentinel) — for now we collapse to wakeAt to keep field count low.
  get done(): boolean { return this.wakeAt < 0; }
  constructor(readonly gen: Animator<any>) {}
}

class Ticker {
  alive = true;
  t = 0;  // accumulated time since registration; saves drive() a closure var
  constructor(readonly cb: (dt: number, t: number) => void) {}
}

export class Anim implements RuntimeAccess {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  private deadSeen = 0;
  clock = 0;

  // ── Public API ────────────────────────────────────────────────

  /** Top-level register. Returns a disposer that cancels the active. */
  run(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof g === "function" ? g() : g);
    return () => this.cancel(a);
  }

  /** Cancel everything, reset clock. */
  stop(): void {
    for (const a of this.actives.slice()) this.cancel(a);
    this.actives.length = 0;
    this.tickers.length = 0;
    this.clock = 0;
  }

  /** Advance by `dt` seconds. */
  step(dt: number): void {
    if (dt > 0) this.clock += dt;

    // Tickers — the hot path. drive() registers here, so per-frame
    // work bypasses generator dispatch entirely.
    const ts = this.tickers;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      t.t += dt;
      try { t.cb(dt, t.t); }
      catch (e) { console.error("minim:", e); t.alive = false; continue; }
      if (t.alive) ts[tw++] = t;
    }
    ts.length = tw;

    // Actives — wake sleepers and ready ones; parked actives are skipped
    // (wakeAt = Infinity > clock).
    const arr = this.actives;
    const len = arr.length;
    const dead0 = this.deadSeen;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (a.wakeAt >= 0 && a.wakeAt <= this.clock) {
        a.wakeAt = 0;
        this.advance(a, dt);
      }
    }

    // Lazy compaction — only walk the array when something died.
    if (this.deadSeen !== dead0) {
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].wakeAt >= 0) arr[w++] = arr[i];
      }
      arr.length = w;
    }
  }

  /** RuntimeAccess: top-level frame callback (no host). Used by
   *  external clients and (internally) by SuspendFn's `rt.onFrame`. */
  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t = new Ticker(cb);
    this.tickers.push(t);
    return () => { t.alive = false; };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  private spawn(g: Animator<any>, onDone?: (v: any) => void): Active {
    const a = new Active(g);
    if (onDone) a.onDone = onDone;
    this.actives.push(a);
    this.advance(a, undefined);
    return a;
  }

  /** Cancellation in one place. Idempotent. */
  private cancel(a: Active): void {
    if (a.wakeAt < 0) return;
    a.wakeAt = -1; this.deadSeen++;
    // Release whatever this active is parked on.
    const c = a.cleanup; a.cleanup = null;
    if (c) c();
    // Defer .return() if we're re-entered from inside our own advance.
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch {}
  }

  // ── Yield-protocol dispatch ───────────────────────────────────

  private advance(a: Active, resume: any): void {
    a.busy = true;
    try {
      let r = a.gen.next(resume);
      while (!r.done) {
        if (a.wakeAt < 0) return;
        const v = r.value;

        if (v === undefined) return;             // park one frame

        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = this.clock + v; return; }
          r = a.gen.next(0); continue;           // tail-call (yield 0)
        }

        if (typeof v === "function") {
          return this.subscribe(a, v as SuspendFn<any>);
        }

        return this.spawnKids(a, Array.isArray(v) ? v : [v]);
      }

      // Natural completion.
      if (a.wakeAt < 0) return;
      a.wakeAt = -1; this.deadSeen++;
      const cb = a.onDone; a.onDone = null;
      if (cb) cb(r.value);
    } catch (e) {
      console.error("minim:", e);
      if (a.wakeAt >= 0) { a.wakeAt = -1; this.deadSeen++; }
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try { a.gen.return(undefined); } catch {}
      }
    }
  }

  // ── Suspension (callback-driven wake) ─────────────────────────

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    // Children spawned via the SuspendFn's `spawn` arg. Captured in a
    // closure rather than tracked on the Active so cancel cascade is
    // a single `cleanup()` call.
    let subKids: Active[] | null = null;

    const wake = (val?: any): void => {
      if (resumed || a.wakeAt < 0) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = 0;
      if (c) c();
      this.advance(a, val);
    };

    const spawn: SpawnFn = (g, oc) => {
      const c = this.spawn(g, oc as any);
      (subKids ??= []).push(c);
      return () => {
        if (subKids) {
          const i = subKids.indexOf(c);
          if (i >= 0) subKids.splice(i, 1);
        }
        this.cancel(c);
      };
    };

    const userDispose = impl(wake, spawn, this);

    // Most SuspendFn impls don't use `spawn` (drive, untilEvent,
    // untilPromise, …). When subKids is null we can store userDispose
    // directly — saves a wrapper closure per subscribe (measurable
    // win on drive-heavy workloads since they allocate one subscribe
    // per active).
    const dispose: () => void = subKids === null
      ? userDispose
      : (): void => {
          try { userDispose(); } catch (e) { console.error("minim:", e); }
          if (subKids) {
            const ks = subKids; subKids = null;
            for (const c of ks) if (c.wakeAt >= 0) this.cancel(c);
          }
        };

    if (resumed || a.wakeAt < 0) {
      try { dispose(); } catch {}
    } else {
      a.wakeAt = Infinity;
      a.cleanup = dispose;
    }
  }

  // ── Parallel children (yield [a, b, c]) ──────────────────────
  //
  // Same closure-cleanup pattern as `subscribe`. The parent captures
  // its children locally; its `cleanup` cancels them on parent cancel.
  // Child completion fires `onDone`, decrementing the alive counter.

  private spawnKids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, undefined);
    const children: Active[] = [];
    let left = kids.length;
    a.wakeAt = Infinity;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt >= 0) this.cancel(c);
    };
    const onChild = (): void => {
      if (--left === 0 && a.cleanup !== null && a.wakeAt >= 0) {
        a.cleanup = null;
        a.wakeAt = 0;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt < 0) return;
      const k = kids[j];
      const child = this.spawn(
        isGen(k) ? k : (function* () { yield k as any; })(),
        onChild,
      );
      children.push(child);
    }
  }
}

/** Tick `step(dt, t)` each frame. Return `false` to complete. Uses
 *  the runtime ticker, so per-frame cost is one direct callback —
 *  no `gen.next()` per frame. */
export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, rt) =>
    rt.onFrame((dt, t) => { if (step(dt, t) === false) wake(); }),
  );
}

// ── attachRaf — RAF lives outside the engine so the engine works in
//    Node, in tests, in offscreen scheduling, etc. ──────────────────

export function attachRaf(anim: Anim): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  let rafId = 0, last = 0;
  const tick = (now: number): void => {
    rafId = requestAnimationFrame(tick);
    const dt = last === 0 ? 0 : Math.min(now - last, FRAME_CAP_MS) / 1000;
    last = now;
    anim.step(dt);
  };
  rafId = requestAnimationFrame(tick);
  return () => { if (rafId) cancelAnimationFrame(rafId); rafId = 0; last = 0; };
}
