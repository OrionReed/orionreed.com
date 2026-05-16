// Generator-driven cooperative animation runtime.
//
// Yield contract:
//   undefined   park 1 frame; resume with dt
//   number > 0  sleep N seconds
//   number ≤ 0  tail-call (resume immediately)
//   Animator    spawn child; resume with R when it completes
//   Yieldable[] spawn all in parallel; resume when all complete
//   SuspendFn   callback wake; resume with T
//
// SuspendFn signature: `(wake, spawn, anim) => dispose`. The `anim`
// arg is the host engine, which means SuspendFns are first-class
// engine primitives — they can:
//   - read `anim.clock` for engine-time guards (e.g. withTimeout)
//   - call `anim.onFrame(cb)` to bypass per-frame `gen.next()` cost
//     (this is how `drive` is built)
//   - install a scoped `anim.observer` and restore it on dispose
// The `spawn` arg is `anim`-bound but exposed separately because
// children spawned through it cascade-cancel with the parent active.
//
// Time-scale, per-step tracing, and similar concerns are NOT runtime
// features. They're userland generator wrappers (`mapDt`, `tap`,
// `record`, …) — see `core/composability.ts`.

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

/** Wraps a non-generator Yieldable in a one-shot generator. */
function* asGen(y: Yieldable): Animator<any> { yield y; }

/** Optional per-engine span observer; opt-in for the assert/spans
 *  layer. Set `anim.observer` to subscribe; subscribers compose in
 *  user code (the runtime sees one slot). */
export interface AnimObserver {
  spawn?(id: number, parentId: number | undefined, clock: number, gen: Animator<any>): void;
  complete?(id: number, clock: number): void;
  cancel?(id: number, clock: number): void;
}

class Active {
  // wakeAt: −1 done · 0 ready · >0 sleeping vs engine clock · Infinity parked.
  wakeAt = 0;
  // Disposer for the resource this active is parked on. For SuspendFn
  // parks: the impl's returned dispose. For parallel-waiting parents:
  // a closure that cancels the kids. The two never coexist.
  cleanup: (() => void) | null = null;
  /** Set on actives spawned as tracked children; called on completion. */
  onDone: ((v: any) => void) | null = null;
  // Re-entrancy guard: cancel-during-advance defers `gen.return()`.
  busy = false;
  pendingReturn = false;
  // Set when an observer is registered at spawn time; 0 means unobserved.
  observeId = 0;
  constructor(readonly gen: Animator<any>) {}
}

class Ticker {
  alive = true;
  /** Engine clock at registration; per-tick `t` is `clock - t0`. */
  t0 = 0;
  constructor(readonly cb: (dt: number, t: number) => void) {}
}

/** Hoisted so the ticker loop body stays catch-free; TurboFan
 *  optimises catch-free loops more aggressively. */
function safeTick(t: Ticker, dt: number, time: number): void {
  try { t.cb(dt, time); }
  catch (e) { console.error("minim:", e); t.alive = false; }
}

export class Anim {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  /** Bumped on each death; step compacts only when this changes. */
  private deadSeen = 0;
  private nextObserveId = 0;
  /** Optional lifecycle observer (assert/spans). Single slot. */
  observer: AnimObserver | undefined = undefined;
  /** Engine time in seconds since last `stop()`. */
  clock = 0;

  /** Run `g` (or its result if a factory). Returns a disposer. */
  run(g: Animator<any> | (() => Animator<any>)): () => void {
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

    const ts = this.tickers;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      safeTick(t, dt, clock - t.t0);
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

  /** Register a per-frame callback. The cb receives `(dt, t-since-reg)`. */
  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t = new Ticker(cb);
    t.t0 = this.clock;
    this.tickers.push(t);
    return () => { t.alive = false; };
  }

  private spawn(
    g: Animator<any>,
    parent: Active | null,
    onDone: ((v: any) => void) | null = null,
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

  private cancel(a: Active): void {
    if (a.wakeAt < 0) return;
    a.wakeAt = -1; this.deadSeen++;
    if (this.observer?.cancel) this.observer.cancel(a.observeId, this.clock);
    const c = a.cleanup; a.cleanup = null;
    if (c) c();
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
      if (this.observer?.complete) this.observer.complete(a.observeId, this.clock);
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

    // Per-disposer indexOf+splice would tidy subKids on individual
    // child cancel; the host's wrapping cleanup already filters dead
    // entries via `wakeAt >= 0`, so we skip it.
    const spawn: SpawnFn = <R>(g: Animator<R>, oc?: (v: R) => void) => {
      const c = this.spawn(g, a, oc as any);
      (subKids ??= []).push(c);
      return () => this.cancel(c);
    };

    const userDispose = impl(wake, spawn, this);

    // Lazy wrap: most SuspendFns (drive, untilEvent, untilPromise)
    // never call `spawn`, so the wrapper is unnecessary — saves a
    // closure allocation per subscribe.
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

  /** Fast path for `yield childGen` — single Animator. Avoids the
   *  kids array, the `children` capture, and the count-down closure
   *  that `spawnKids` allocates. */
  private spawnOne(a: Active, child: Animator<any>): void {
    a.wakeAt = Infinity;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt >= 0) this.cancel(c); };
    c = this.spawn(child, a, () => {
      if (a.wakeAt === Infinity && a.cleanup !== null) {
        a.cleanup = null;
        a.wakeAt = 0;
        this.advance(a, undefined);
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

/** Tick `step(dt, t)` each frame. Return `false` to complete. Routes
 *  through `onFrame` so the per-frame cost is one direct callback,
 *  not a `gen.next()`. */
export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, anim) =>
    anim.onFrame((dt, t) => { if (step(dt, t) === false) wake(); }),
  );
}

/** Browser RAF adapter. Caps single-frame dt at 32 ms so tab-
 *  backgrounding (where browsers throttle then resume with the
 *  accumulated delta) doesn't deliver one giant frame. Returns a
 *  disposer that cancels the RAF loop. */
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
