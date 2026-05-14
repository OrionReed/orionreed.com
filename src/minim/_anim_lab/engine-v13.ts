// v13 — v12 with the gaps closed:
//
//   • Reactive per-Active scale restored (`.at(signal)` works again).
//     `hasReactiveScale` gates a per-step spawn-order chain refresh;
//     when nobody passes a thunk, zero overhead. ~10 lines.
//
//   • `clockMs` / `onClock` → single `onTick(dt)` API.
//     Engine no longer owns a clock at all. Consumers that need a
//     value (clockSignal, span-bar progress) accumulate from `dt`:
//
//       const s = cell(0);
//       anim.onTick(dt => s.value += dt);
//
//     Net: ~5 lines saved + one engine concept dropped.
//
//   • RAF stays decoupled but `attachRaf` is auto-idle.
//     Engine exposes `hasWork()` and `onActivity` (single optional
//     property; fires when work appears). The adapter starts the rAF
//     loop only while there's work to do — Diagrams that have settled
//     pay zero rAF cost until something wakes.
//
// Everything else from v12 (single Active class, wakeAt-as-state,
// fused suspendOnChildren, parent.children, tickers) is unchanged.

const FRAME_CAP_MS = 32;

export interface RuntimeAccess {
  onFrame(cb: (dt: number, t: number) => void): () => void;
}

export type SpawnFn = <R>(
  g: Animator<R>,
  onComplete?: (v: R) => void,
  scale?: number | (() => number),
) => () => void;

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
  runtime: RuntimeAccess,
) => () => void;

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

export const isGen = (v: unknown): v is Animator<any> =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Animator<any>).next === "function";

class Active {
  // wakeAt: 0=ready, >0=sleeping (own-clock target), Infinity=parked.
  wakeAt = 0;
  clock = 0;
  scale: number | (() => number) = 1;
  effScale: number;
  dispose: (() => void) | undefined = undefined;
  onComplete: ((v: unknown) => void) | undefined = undefined;
  children: Active[] | undefined = undefined;
  done = false;
  inAdvance = false;
  pendingReturn = false;
  constructor(
    readonly gen: Animator<any>,
    readonly parent: Active | undefined,
    scale: number | (() => number),
  ) {
    this.scale = scale;
    const own = typeof scale === "number" ? scale : scale();
    this.effScale = (parent ? parent.effScale : 1) * own;
  }
}

interface Ticker {
  cb: (dt: number, t: number) => void;
  t: number;
  alive: boolean;
  host: Active | undefined;
}

export class Anim implements RuntimeAccess {
  private active: Active[] = [];
  private tickers: Ticker[] = [];
  private tickListeners: Array<(dt: number) => void> | undefined;
  private subscribingHost: Active | undefined = undefined;
  // Set true the first time anyone passes a thunk-shaped scale. Never
  // reset; cost of leaving true is one chain-refresh pass per step.
  private hasReactiveScale = false;

  /** Set by adapters (e.g. `attachRaf`) that want to know when the
   *  engine transitions from idle to non-idle. Fired from `spawn()`,
   *  `onFrame()`, and `onTick()`. Single slot — only one adapter at
   *  a time. Multiple subscribers compose via fan-out in user code. */
  onActivity: (() => void) | undefined = undefined;

  /** Cheap predicate: is there anything for the engine to do? */
  hasWork(): boolean {
    return this.active.length > 0 || this.tickers.length > 0;
  }

  /** Fire `cb(dt)` once per `step(dt)` call. Returns a disposer. The
   *  engine itself doesn't track absolute time — consumers accumulate
   *  what they need from the `dt` deltas. */
  onTick(cb: (dt: number) => void): () => void {
    if (!this.tickListeners) this.tickListeners = [cb];
    else this.tickListeners.push(cb);
    this.onActivity?.();
    return () => {
      const ls = this.tickListeners;
      if (!ls) return;
      const i = ls.indexOf(cb);
      if (i >= 0) ls.splice(i, 1);
      if (ls.length === 0) this.tickListeners = undefined;
    };
  }

  /** Drive-style per-frame callback. Inside a SuspendFn the host
   *  active's effective scale and lifecycle apply. */
  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t: Ticker = { cb, t: 0, alive: true, host: this.subscribingHost };
    this.tickers.push(t);
    this.onActivity?.();
    return () => { t.alive = false; };
  }

  run(arg: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof arg === "function" ? arg() : arg, undefined, 1);
    return () => this.cancel(a);
  }

  stop(): void {
    for (const a of this.active.slice()) this.cancel(a);
    this.active.length = 0;
    for (const t of this.tickers) t.alive = false;
    this.tickers.length = 0;
  }

  step(dt: number): void {
    if (dt > 0 && this.tickListeners) {
      const ls = this.tickListeners;
      for (let i = 0; i < ls.length; i++) ls[i](dt);
    }
    const arr = this.active;
    const len = arr.length;
    // Refresh the effScale chain for reactive-scale users; spawn order
    // ensures parents precede children so descendants see fresh values.
    if (this.hasReactiveScale) {
      for (let i = 0; i < len; i++) {
        const a = arr[i];
        if (a.done) continue;
        const s = a.scale;
        const own = typeof s === "number" ? s : s();
        a.effScale = (a.parent ? a.parent.effScale : 1) * own;
      }
    }
    let w = 0;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (a.done) continue;
      const scaled = dt * a.effScale;
      a.clock += scaled;
      if (a.wakeAt <= a.clock) {
        a.wakeAt = 0;
        this.advance(a, scaled);
      }
      if (!a.done) { if (i !== w) arr[w] = a; w++; }
    }
    arr.length = w;
    const ts = this.tickers;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      const host = t.host;
      if (host && host.done) { t.alive = false; continue; }
      const scaled = host ? dt * host.effScale : dt;
      t.t += scaled;
      t.cb(scaled, t.t);
      if (!t.alive) continue;
      if (i !== tw) ts[tw] = t;
      tw++;
    }
    ts.length = tw;
  }

  private spawn(
    g: Animator<any>,
    parent: Active | undefined,
    scale: number | (() => number),
    onComplete?: (v: unknown) => void,
  ): Active {
    if (typeof scale !== "number") this.hasReactiveScale = true;
    const a = new Active(g, parent, scale);
    a.onComplete = onComplete;
    if (parent) (parent.children ??= []).push(a);
    this.active.push(a);
    if (this.active.length === 1) this.onActivity?.();
    this.advance(a, undefined);
    return a;
  }

  private cancel(a: Active): void {
    if (a.done) return;
    a.done = true;
    const d = a.dispose; a.dispose = undefined;
    if (d) d();
    if (a.parent?.children) {
      const cs = a.parent.children;
      const i = cs.indexOf(a);
      if (i >= 0) cs.splice(i, 1);
    }
    if (a.children) {
      const cs = a.children; a.children = undefined;
      for (let i = 0; i < cs.length; i++) if (!cs[i].done) this.cancel(cs[i]);
    }
    if (a.inAdvance) { a.pendingReturn = true; return; }
    a.gen.return(undefined);
  }

  private advance(a: Active, resume: unknown): void {
    a.inAdvance = true;
    try {
      let r = a.gen.next(resume as number);
      while (!r.done) {
        if (a.done) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = a.clock + v; return; }
          r = a.gen.next(0); continue;
        }
        if (typeof v === "function") {
          let resumed = false, setupOk = true;
          const wake = (val?: unknown): void => {
            if (resumed || a.done) return;
            resumed = true;
            const d = a.dispose; a.dispose = undefined;
            a.wakeAt = 0;
            if (d) d();
            this.advance(a, val);
          };
          const spawn: SpawnFn = (g, oc, sc) => {
            if (!setupOk) throw new Error("minim: spawn() valid only during suspend setup");
            const c = this.spawn(g, a, sc ?? 1, oc as any);
            return () => this.cancel(c);
          };
          const prev = this.subscribingHost;
          this.subscribingHost = a;
          let dispose: () => void;
          try { dispose = (v as SuspendFn<any>)(wake, spawn, this); }
          finally { this.subscribingHost = prev; }
          setupOk = false;
          if (resumed || a.done) dispose();
          else { a.wakeAt = Infinity; a.dispose = dispose; }
          return;
        }
        const kids = Array.isArray(v) ? v : [v];
        if (kids.length === 0) { r = a.gen.next(0); continue; }
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
          this.spawn(isGen(k) ? k : (function*() { yield k as any; })(), a, 1, onChild);
        }
        return;
      }
      if (a.done) return;
      a.done = true;
      if (a.parent?.children) {
        const cs = a.parent.children;
        const i = cs.indexOf(a);
        if (i >= 0) cs.splice(i, 1);
      }
      const cb = a.onComplete; a.onComplete = undefined;
      if (cb) cb(r.value);
    } catch (e) {
      console.error("minim: animator threw", e);
      a.done = true;
    } finally {
      a.inAdvance = false;
      if (a.pendingReturn) { a.pendingReturn = false; a.gen.return(undefined); }
    }
  }
}

// drive() — uses the ticker fast path. `yield* drive(step)` from any gen.
export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, anim) =>
    anim.onFrame((dt, t) => { if (step(dt, t) === false) wake(); }),
  );
}

// ── Browser RAF adapter — auto-idle ──────────────────────────────────
//
// Loops while `anim.hasWork()`; sleeps when idle and re-arms on the
// next `onActivity` (spawn / onFrame / onTick). Single adapter slot
// per Anim — calling `attachRaf` twice replaces the prior adapter.

export function attachRaf(anim: Anim): () => void {
  let rafId = 0;
  let last = 0;
  const tick = (now: number): void => {
    rafId = 0;
    const dt = last === 0 ? 0 : Math.min(now - last, FRAME_CAP_MS) / 1000;
    last = now;
    anim.step(dt);
    if (anim.hasWork()) rafId = requestAnimationFrame(tick);
    else last = 0;
  };
  const start = (): void => {
    if (rafId !== 0) return;
    last = 0;
    rafId = requestAnimationFrame(tick);
  };
  anim.onActivity = start;
  if (anim.hasWork()) start();
  return () => {
    if (anim.onActivity === start) anim.onActivity = undefined;
    cancelAnimationFrame(rafId);
    rafId = 0;
  };
}
