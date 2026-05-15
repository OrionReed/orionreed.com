// engine-simple — optimised for clarity, not LoC.
//
// Yield contract (same as current):
//   undefined        → park 1 frame; resume with dt
//   number > 0       → sleep N seconds
//   number ≤ 0       → tail-call (resume immediately)
//   Animator<R>      → spawn child; resume with R when it completes
//   Yieldable[]      → spawn all in parallel; resume when all complete
//   SuspendFn<T>     → callback wake; resume with T
//
// Authoring is plain `function*`. Time-scale, observer, and clock
// listeners are NOT runtime concerns — userland generator wrappers
// (`mapDt`, `tap`, etc).
//
// State design — what's on each Active:
//
//   done        : has it finished (cancel or natural)?
//   wakeAt      : 0 = ready · >0 = sleeping vs engine clock · Infinity = parked
//   cleanup     : single slot for "what to release when this active is
//                 cancelled or wakes up". For a SuspendFn-parked active
//                 it holds the impl's disposer. For a parallel-waiting
//                 parent it holds a closure that cancels its kids. The
//                 two states never coexist, so one slot is enough.
//   onDone      : "tell my parent I'm done with this value" — only set
//                 on actives spawned as children of a parallel parent.
//   busy        : true while inside .advance(); defers cancel-via-return
//                 if a re-entrant cancel arrives.
//   pendingReturn : true if cancel was deferred above; cleared in finally.
//
// Notably absent (vs current/v31):
//   - `par` pointer / `kids[]` array / detach helper. The parallel parent
//     captures its kids in its cleanup closure; when cancelled, the
//     closure cancels them. When kids complete naturally, they fire
//     `onDone` (a counter); no parent-side bookkeeping needed.

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  rt: { onFrame(cb: (dt: number) => void): () => void },
) => () => void;

export type Yieldable = number | undefined | Animator<any> | Yieldable[] | SuspendFn<any>;
export type Animator<R = void> = Generator<Yieldable, R, number>;

/** `yield* suspend(impl)` parks until `wake(value)` is called. */
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

const isGen = (v: any): v is Animator<any> =>
  v != null && typeof v === "object" && typeof v.next === "function";

class Active {
  done = false;
  wakeAt = 0;
  cleanup: (() => void) | null = null;
  onDone: ((v: any) => void) | null = null;
  busy = false;
  pendingReturn = false;
  constructor(readonly gen: Animator<any>) {}
}

class Ticker {
  alive = true;
  constructor(readonly cb: (dt: number) => void) {}
}

export class Anim {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  private deadSeen = 0;
  clock = 0;

  // ── Public API ────────────────────────────────────────────────

  run(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof g === "function" ? g() : g);
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

    // Tickers — the hot path. drive() registers here, so per-frame
    // work bypasses generator dispatch entirely.
    const ts = this.tickers;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      try { t.cb(dt); }
      catch (e) { console.error("minim:", e); t.alive = false; continue; }
      if (t.alive) ts[tw++] = t;
    }
    ts.length = tw;

    // Actives — wake sleepers and ready actives.
    const arr = this.actives;
    const len = arr.length;
    const dead0 = this.deadSeen;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (!a.done && a.wakeAt <= this.clock) {
        a.wakeAt = 0;
        this.advance(a, dt);
      }
    }

    // Lazy compaction — only walk the array when something died.
    if (this.deadSeen !== dead0) {
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        if (!arr[i].done) arr[w++] = arr[i];
      }
      arr.length = w;
    }
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
    if (a.done) return;
    a.done = true;
    this.deadSeen++;
    // Release whatever this active is parked on. For a suspended
    // active that's the SuspendFn's disposer. For a parallel-waiting
    // parent that's a closure cancelling its kids.
    const c = a.cleanup;
    a.cleanup = null;
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
        if (a.done) return;
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
      if (a.done) return;
      a.done = true;
      this.deadSeen++;
      const cb = a.onDone;
      a.onDone = null;
      if (cb) cb(r.value);
    } catch (e) {
      console.error("minim:", e);
      if (!a.done) { a.done = true; this.deadSeen++; }
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
    const wake = (val?: any): void => {
      if (resumed || a.done) return;
      resumed = true;
      const c = a.cleanup;
      a.cleanup = null;
      a.wakeAt = 0;
      if (c) c();
      this.advance(a, val);
    };
    const onFrame = (cb: (dt: number) => void): (() => void) => {
      const t = new Ticker(cb);
      this.tickers.push(t);
      return () => { t.alive = false; };
    };
    const dispose = impl(wake, { onFrame });
    if (resumed || a.done) {
      try { dispose(); } catch {}
    } else {
      a.wakeAt = Infinity;
      a.cleanup = dispose;
    }
  }

  // ── Parallel children (yield [a, b, c]) ──────────────────────
  //
  // No `par`/`kids` on Active. The parent captures its kids in a
  // local array; its `cleanup` closure cancels them on parent cancel.
  // Child completion fires `onDone`, decrementing the alive counter.

  private spawnKids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, undefined);
    const children: Active[] = [];
    let left = kids.length;
    a.wakeAt = Infinity;
    a.cleanup = () => {
      for (const c of children) if (!c.done) this.cancel(c);
    };
    const onChild = (): void => {
      if (--left === 0 && a.cleanup !== null && !a.done) {
        a.cleanup = null;
        a.wakeAt = 0;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.done) return;
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
 *  the runtime ticker, so per-frame cost is one direct callback. */
export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, rt) => {
    let t = 0;
    return rt.onFrame((dt) => {
      t += dt;
      if (step(dt, t) === false) wake();
    });
  });
}
