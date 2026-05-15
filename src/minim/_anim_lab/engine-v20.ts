// v20 — Function-based engine. No `class Anim`; the API is returned
// from a factory closure. Internal state lives in the closure.
//
// Same semantics as v19 (single hot loop, wakeAt encoding, generator-
// only model, no tickers). Question: does removing the class shape
// make it smaller / clearer / faster?
//
// Public API:
//   const anim = createAnim()
//   anim.run(gen | factory)  → dispose
//   anim.step(dt)
//   anim.stop()
//
//   drive(step), suspend(impl) — user-space helpers
//   attachRaf(anim) — browser rAF adapter

const FRAME_CAP_MS = 32;

export type SpawnFn = <R>(
  g: Animator<R>,
  onComplete?: (v: R) => void,
  scale?: number | (() => number),
) => () => void;

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
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

interface Active {
  gen: Animator<any>;
  parent: Active | undefined;
  // wakeAt: 0 ready, >0 sleeping (own-clock target), Infinity parked.
  wakeAt: number;
  clock: number;
  scale: number | (() => number);
  effScale: number;
  dispose: (() => void) | undefined;
  onComplete: ((v: unknown) => void) | undefined;
  children: Active[] | undefined;
  done: boolean;
  inAdvance: boolean;
  pendingReturn: boolean;
}

export interface Anim {
  run(arg: Animator<any> | (() => Animator<any>)): () => void;
  step(dt: number): void;
  stop(): void;
}

export function createAnim(): Anim {
  const live: Active[] = [];

  function makeActive(
    gen: Animator<any>,
    parent: Active | undefined,
    scale: number | (() => number),
  ): Active {
    return {
      gen, parent, scale,
      wakeAt: 0, clock: 0, effScale: 1,
      dispose: undefined, onComplete: undefined, children: undefined,
      done: false, inAdvance: false, pendingReturn: false,
    };
  }

  function detach(a: Active): void {
    const cs = a.parent?.children;
    if (!cs) return;
    const i = cs.indexOf(a);
    if (i >= 0) cs.splice(i, 1);
  }

  function spawn(
    g: Animator<any>,
    parent: Active | undefined,
    scale: number | (() => number),
    onComplete?: (v: unknown) => void,
  ): Active {
    const a = makeActive(g, parent, scale);
    a.onComplete = onComplete;
    if (parent) (parent.children ??= []).push(a);
    live.push(a);
    advance(a, undefined);
    return a;
  }

  function cancel(a: Active): void {
    if (a.done) return;
    a.done = true;
    const d = a.dispose; a.dispose = undefined;
    if (d) d();
    detach(a);
    const cs = a.children;
    if (cs) {
      a.children = undefined;
      for (let i = 0; i < cs.length; i++) if (!cs[i].done) cancel(cs[i]);
    }
    if (a.inAdvance) { a.pendingReturn = true; return; }
    a.gen.return(undefined);
  }

  function subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const wake = (v?: unknown): void => {
      if (resumed || a.done) return;
      resumed = true;
      const d = a.dispose; a.dispose = undefined;
      a.wakeAt = 0;
      if (d) d();
      advance(a, v);
    };
    const spawnFn: SpawnFn = (g, oc, sc) => {
      const c = spawn(g, a, sc ?? 1, oc as any);
      return () => cancel(c);
    };
    const dispose = impl(wake, spawnFn);
    if (resumed || a.done) dispose();
    else { a.wakeAt = Infinity; a.dispose = dispose; }
  }

  function waitChildren(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) { advance(a, undefined); return; }
    let left = kids.length;
    a.wakeAt = Infinity;
    const onChild = (): void => {
      if (--left === 0 && a.wakeAt === Infinity && !a.done) {
        a.wakeAt = 0;
        advance(a, undefined);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.done) return;
      const k = kids[j];
      spawn(isGen(k) ? k : (function*() { yield k as any; })(), a, 1, onChild);
    }
  }

  function advance(a: Active, resume: unknown): void {
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
        if (typeof v === "function") { subscribe(a, v as SuspendFn<any>); return; }
        waitChildren(a, Array.isArray(v) ? v : [v]);
        return;
      }
      if (a.done) return;
      a.done = true;
      detach(a);
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

  return {
    run(arg) {
      const a = spawn(typeof arg === "function" ? arg() : arg, undefined, 1);
      return () => cancel(a);
    },
    stop() {
      for (const a of live.slice()) cancel(a);
      live.length = 0;
    },
    step(dt) {
      const len = live.length;
      let w = 0;
      for (let i = 0; i < len; i++) {
        const a = live[i];
        if (a.done) continue;
        const s = a.scale;
        const own = typeof s === "number" ? s : s();
        a.effScale = (a.parent ? a.parent.effScale : 1) * own;
        const scaled = dt * a.effScale;
        a.clock += scaled;
        if (a.wakeAt <= a.clock) {
          a.wakeAt = 0;
          advance(a, scaled);
        }
        if (!a.done) { if (i !== w) live[w] = a; w++; }
      }
      live.length = w;
    },
  };
}

// Class wrapper for migration parity (so `new Anim()` still works).
export class Anim {
  private impl = createAnim();
  run = this.impl.run;
  step = this.impl.step;
  stop = this.impl.stop;
}

// ── drive() — `yield* drive(step)` from any animator ────────────────

export function* drive(step: (dt: number, t: number) => boolean | void): Animator {
  let t = 0;
  while (true) {
    const dt = yield;
    t += dt;
    if (step(dt, t) === false) return;
  }
}

// ── attachRaf — browser rAF adapter ─────────────────────────────────

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
