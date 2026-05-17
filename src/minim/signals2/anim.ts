// anim.ts — generator-driven cooperative animation runtime.
//
// Yield contract (from inside an Animator):
//   undefined   park 1 frame, resume with dt
//   number > 0  sleep N seconds
//   number ≤ 0  tail-call (resume immediately)
//   Animator    spawn child; resume with R when it completes
//   Yieldable[] spawn all in parallel; resume when all complete
//   SuspendFn   callback wake; resume with T
//
// SuspendFn: `(wake, spawn, anim) => dispose`. The `anim` arg lets
// SuspendFns be first-class engine primitives (read clock, install
// frame callbacks via `anim.onFrame`, spawn cascade-cancelling kids).
//
// Adapted from `core/anim.ts` for self-contained signals2 prototype.

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

export type SpawnFn = <R>(
  g: Animator<R>,
  onDone?: (v: R) => void,
) => () => void;

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
  anim: Anim,
) => () => void;

/** `yield* suspend(impl)` parks until `wake(value)`; resumes with `value`. */
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

export const isGen = (v: any): v is Animator<any> =>
  typeof v?.next === "function";

function* asGen(y: Yieldable): Animator<any> { yield y; }

class Active {
  // wakeAt: −1 done · 0 ready · >0 sleeping · Infinity parked.
  wakeAt = 0;
  cleanup: (() => void) | null = null;
  onDone: ((v: any) => void) | null = null;
  busy = false;
  pendingReturn = false;
  constructor(readonly gen: Animator<any>) {}
}

class Ticker {
  alive = true;
  t0 = 0;
  constructor(readonly cb: (dt: number, t: number) => void) {}
}

export class Anim {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  private deadSeen = 0;
  /** Engine time in seconds since last `stop()`. */
  clock = 0;
  /** Override to route runtime errors. */
  onError: (e: unknown) => void = (e) => { console.error("anim:", e); };

  /** Run `g` (or its result if a factory). Returns a disposer. */
  run<R>(g: Animator<R> | (() => Animator<R>)): () => void {
    const a = this.spawn(typeof g === "function" ? g() : g, null);
    return () => this.cancel(a);
  }

  /** Cancel everything; reset clock. */
  stop(): void {
    for (const a of this.actives) this.cancel(a);
    this.actives.length = 0;
    this.tickers.length = 0;
    this.clock = 0;
  }

  /** Advance by `dt` seconds. */
  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const clock = this.clock;
    const onErr = this.onError;

    const ts = this.tickers;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      try { t.cb(dt, clock - t.t0); }
      catch (e) { onErr(e); t.alive = false; }
      if (t.alive) ts[tw++] = t;
    }
    ts.length = tw;

    const arr = this.actives;
    const len = arr.length;
    const dead0 = this.deadSeen;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (a.wakeAt >= 0 && a.wakeAt <= clock) {
        a.wakeAt = 0;
        this.advance(a, dt);
      }
    }
    if (this.deadSeen !== dead0) {
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].wakeAt >= 0) arr[w++] = arr[i];
      }
      arr.length = w;
    }
  }

  /** Per-frame callback. Used by `drive`. */
  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t = new Ticker(cb);
    t.t0 = this.clock;
    this.tickers.push(t);
    return () => { t.alive = false; };
  }

  private spawn(
    g: Animator<any>,
    _parent: Active | null,
    onDone: ((v: any) => void) | null = null,
  ): Active {
    const a = new Active(g);
    a.onDone = onDone;
    this.actives.push(a);
    this.advance(a, undefined);
    return a;
  }

  private cancel(a: Active): void {
    if (a.wakeAt < 0) return;
    a.wakeAt = -1; this.deadSeen++;
    const c = a.cleanup; a.cleanup = null;
    if (c) try { c(); } catch (e) { this.onError(e); }
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch {}
  }

  private advance(a: Active, resume: any): void {
    a.busy = true;
    try {
      let r = a.gen.next(resume);
      while (!r.done) {
        if (a.wakeAt < 0) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = this.clock + v; return; }
          r = a.gen.next(0); continue;
        }
        if (typeof v === "function") return this.subscribe(a, v as SuspendFn<any>);
        if (Array.isArray(v)) return this.spawnKids(a, v);
        return this.spawnOne(a, v as Animator<any>);
      }
      // Natural completion.
      if (a.wakeAt < 0) return;
      a.wakeAt = -1; this.deadSeen++;
      const cb = a.onDone; a.onDone = null;
      if (cb) cb(r.value);
    } catch (e) {
      this.onError(e);
      if (a.wakeAt >= 0) { a.wakeAt = -1; this.deadSeen++; }
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try { a.gen.return(undefined); } catch {}
      }
    }
  }

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    let subKids: Active[] | null = null;
    const wake = (val?: any): void => {
      if (resumed || a.wakeAt < 0) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = 0;
      if (c) c();
      this.advance(a, val);
    };
    const spawn: SpawnFn = <R>(g: Animator<R>, oc?: (v: R) => void) => {
      const c = this.spawn(g, a, oc as any);
      (subKids ??= []).push(c);
      return () => this.cancel(c);
    };
    const userDispose = impl(wake, spawn, this);
    const dispose: () => void = subKids === null
      ? userDispose
      : (): void => {
          try { userDispose(); } catch (e) { this.onError(e); }
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

  private spawnOne(a: Active, child: Animator<any>): void {
    a.wakeAt = Infinity;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt >= 0) this.cancel(c); };
    c = this.spawn(child, a, (v) => {
      if (a.wakeAt === Infinity && a.cleanup !== null) {
        a.cleanup = null;
        a.wakeAt = 0;
        this.advance(a, v);
      }
    });
  }

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
      const child = this.spawn(isGen(k) ? k : asGen(k), a, onChild);
      children.push(child);
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Standard combinators
// ════════════════════════════════════════════════════════════════════

/** Tick `step(dt, t)` each frame. Return `false` to complete. */
export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, anim) =>
    anim.onFrame((dt, t) => { if (step(dt, t) === false) wake(); }),
  );
}

/** Spawn `g` and DON'T wait — parent resumes immediately. The fork
 *  runs independently to its natural completion.
 *
 *  KNOWN LIMITATION: the fork is NOT cancel-linked to the parent. If
 *  parent is cancelled while fork is mid-flight, fork keeps running
 *  until it completes naturally (or `anim.stop()`). This is a
 *  consequence of the SuspendFn protocol — see `anim.ts` notes. To
 *  get cancel-link behaviour, wrap the fork in `race()` against a
 *  parent-lifetime cell, or use `yield [fork-as-Yieldable]` if you're
 *  okay with waiting. */
export function fork<R>(g: Animator<R>): Animator {
  return suspend<void>((wake, _spawn, anim) => {
    anim.run(g);
    wake();
    return () => {};  // see KNOWN LIMITATION above
  });
}

/** First-completion race; resume with the winner's payload, cancel losers. */
export function race<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<PayloadOf<Cs[number]>> {
  return suspend<PayloadOf<Cs[number]>>((wake, spawn) => {
    let won = false;
    const disposers: Array<() => void> = [];
    const safeWake = (v: any): void => {
      if (won) return;
      won = true;
      for (const d of disposers) try { d(); } catch {}
      (wake as (v: any) => void)(v);
    };
    for (const c of children) {
      const g = isGen(c) ? c : asGen(c);
      disposers.push(spawn(g as Animator<any>, safeWake));
    }
    return () => {
      if (won) return;
      won = true;
      for (const d of disposers) try { d(); } catch {}
    };
  });
}

/** Browser RAF adapter; caps single-frame dt at 32ms. */
export function attachRaf(anim: Anim): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  const FRAME_CAP_MS = 32;
  let rafId = 0, last = 0;
  const tick = (now: number): void => {
    rafId = requestAnimationFrame(tick);
    const dt = last ? Math.min(now - last, FRAME_CAP_MS) / 1000 : 0;
    last = now;
    anim.step(dt);
  };
  rafId = requestAnimationFrame(tick);
  return () => { if (rafId) cancelAnimationFrame(rafId); rafId = 0; last = 0; };
}
