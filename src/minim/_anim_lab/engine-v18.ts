// v18 — Minimum core. Engine is pure stepping; rAF is a 10-line
// adapter exported separately.
//
// Mental model in one paragraph:
//   An Active is a generator + bookkeeping. Each step, every live
//   active gets `clock += dt × effScale`; if its `wakeAt` has been
//   reached, we advance it. Advancing means calling `gen.next(dt)`
//   and routing the yielded value: `undefined` parks it for next
//   frame, `number > 0` schedules a sleep, `function` is an external
//   suspension, a generator (or array of them) becomes child(ren) we
//   wait for. Cancel marks done, runs the disposer, cascades to
//   children. That's the whole engine.
//
// Public API:
//   new Anim()             pure stepping engine
//   anim.run(gen)          → dispose
//   anim.step(dt)          advance by dt seconds
//   anim.stop()            cancel everything
//
//   attachRaf(anim)        → dispose; browser rAF loop driver
//
// drive(step), suspend(impl) — user-space helpers; engine doesn't
// know about them.

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

export class Anim {
  private active: Active[] = [];

  run(arg: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof arg === "function" ? arg() : arg, undefined, 1);
    return () => this.cancel(a);
  }

  stop(): void {
    for (const a of this.active.slice()) this.cancel(a);
    this.active.length = 0;
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
  }

  /** Internal — called by `run` (top-level) and by the spawn closure
   *  passed to SuspendFn impls (children of a parked active). */
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
          const dispose = (v as SuspendFn<any>)(wake, spawn);
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

// ── drive() — yield* this from any animator ─────────────────────────

export function* drive(step: (dt: number, t: number) => boolean | void): Animator {
  let t = 0;
  while (true) {
    const dt = yield;
    t += dt;
    if (step(dt, t) === false) return;
  }
}

// ── attachRaf — browser loop adapter, lives outside the engine ──────

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
