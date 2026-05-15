// v21 — v19 with the smallest-possible tickers re-added.
//
// Tickers are the only way to get drive-style work below "one
// gen.next() per active per frame". v19's universal-generator model
// pays that cost; v21 adds back the v6 ticker primitive in ~15 lines.
//
// Cost: SuspendFn gains a third `anim` arg (additive — old impls work
// unchanged). drive() uses it via `anim.onFrame(cb)`.
//
// Engine concepts now: run / step / stop / onFrame.

const FRAME_CAP_MS = 32;

export interface RuntimeAccess {
  onFrame(cb: (dt: number) => void): () => void;
}

export type SpawnFn = <R>(
  g: Animator<R>,
  onComplete?: (v: R) => void,
  scale?: number | (() => number),
) => () => void;

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
  anim: RuntimeAccess,
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
  // wakeAt: 0 ready, >0 sleeping (own-clock target), Infinity parked.
  wakeAt = 0;
  clock = 0;
  scale: number | (() => number) = 1;
  effScale = 1;
  dispose: (() => void) | undefined = undefined;
  onComplete: ((v: unknown) => void) | undefined = undefined;
  children: Active[] | undefined = undefined;
  done = false;
  inAdvance = false;
  pendingReturn = false;
  constructor(
    readonly gen: Animator<any>,
    readonly parent: Active | undefined,
  ) {}
}

interface Ticker { cb: (dt: number) => void; alive: boolean; }

export class Anim implements RuntimeAccess {
  private active: Active[] = [];
  private tickers: Ticker[] = [];

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

  /** Per-frame callback. Untied to any Active — caller manages lifecycle
   *  via the returned disposer. Used by `drive()` and consumers that
   *  want a raw frame tick (e.g. clockSignal). */
  onFrame(cb: (dt: number) => void): () => void {
    const t: Ticker = { cb, alive: true };
    this.tickers.push(t);
    return () => { t.alive = false; };
  }

  step(dt: number): void {
    const arr = this.active;
    const len = arr.length;
    let w = 0;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (a.done) continue;
      const s = a.scale;
      const own = typeof s === "number" ? s : s();
      a.effScale = (a.parent ? a.parent.effScale : 1) * own;
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
      t.cb(dt);
      if (!t.alive) continue;
      if (i !== tw) ts[tw] = t;
      tw++;
    }
    ts.length = tw;
  }

  // ── Internal lifecycle ──────────────────────────────────────────

  private spawn(
    g: Animator<any>,
    parent: Active | undefined,
    scale: number | (() => number),
    onComplete?: (v: unknown) => void,
  ): Active {
    const a = new Active(g, parent);
    a.scale = scale;
    a.onComplete = onComplete;
    if (parent) (parent.children ??= []).push(a);
    this.active.push(a);
    this.advance(a, undefined);
    return a;
  }

  private cancel(a: Active): void {
    if (a.done) return;
    a.done = true;
    const d = a.dispose; a.dispose = undefined;
    if (d) d();
    this.detach(a);
    const cs = a.children;
    if (cs) {
      a.children = undefined;
      for (let i = 0; i < cs.length; i++) if (!cs[i].done) this.cancel(cs[i]);
    }
    if (a.inAdvance) { a.pendingReturn = true; return; }
    a.gen.return(undefined);
  }

  private detach(a: Active): void {
    const cs = a.parent?.children;
    if (!cs) return;
    const i = cs.indexOf(a);
    if (i >= 0) cs.splice(i, 1);
  }

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const wake = (v?: unknown): void => {
      if (resumed || a.done) return;
      resumed = true;
      const d = a.dispose; a.dispose = undefined;
      a.wakeAt = 0;
      if (d) d();
      this.advance(a, v);
    };
    const spawn: SpawnFn = (g, oc, sc) => {
      const c = this.spawn(g, a, sc ?? 1, oc as any);
      return () => this.cancel(c);
    };
    const dispose = impl(wake, spawn, this);
    if (resumed || a.done) dispose();
    else { a.wakeAt = Infinity; a.dispose = dispose; }
  }

  private waitChildren(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) { this.advance(a, undefined); return; }
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
        if (typeof v === "function") { this.subscribe(a, v as SuspendFn<any>); return; }
        this.waitChildren(a, Array.isArray(v) ? v : [v]);
        return;
      }
      // Natural completion.
      if (a.done) return;
      a.done = true;
      this.detach(a);
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

// ── drive() — uses the ticker fast path. yield* this from any animator.

export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, anim) => {
    let t = 0;
    return anim.onFrame((dt) => {
      t += dt;
      if (step(dt, t) === false) wake();
    });
  });
}

// ── attachRaf — browser rAF adapter, separate from engine ───────────

export function attachRaf(anim: Anim): () => void {
  let rafId = 0;
  let last = 0;
  const tick = (now: number): void => {
    rafId = 0;
    const dt = last === 0 ? 0 : Math.min(now - last, FRAME_CAP_MS) / 1000;
    last = now;
    anim.step(dt);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(rafId); rafId = 0; };
}
