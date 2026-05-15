// v17 — v16 with the scale-refresh loop folded into the main pass.
//
// v16 had two loops in `step()`:
//   1) refresh effScale chain (gated by `hasReactiveScale`)
//   2) tick clock + advance ready actives + compact
//
// v17 collapses them to one. Spawn order guarantees parents are
// visited before children, so by the time a child's effScale is
// recomputed, its parent's is already fresh. The `hasReactiveScale`
// flag, the conditional refresh path, and the gate field all vanish.
// Cost: 5 ns/active/frame extra for purely-static-scale workloads
// (one multiply that was previously skipped). Negligible at 1000-active
// frames.
//
// One mental model: "for every live active, refresh its effScale,
// tick its clock, advance it if its wake time has come, drop it if
// it died". That's the engine's hot loop in five lines.

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

export interface AnimOpts {
  schedule?: (cb: (now: number) => void) => number;
  cancel?: (id: number) => void;
}

const defaultSchedule: (cb: (now: number) => void) => number =
  typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : () => 0;
const defaultCancel: (id: number) => void =
  typeof cancelAnimationFrame !== "undefined" ? cancelAnimationFrame : () => {};

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
  private rafId = 0;
  private lastFrame = 0;
  private readonly schedule: (cb: (now: number) => void) => number;
  private readonly cancelFrame: (id: number) => void;

  constructor(opts: AnimOpts = {}) {
    this.schedule = opts.schedule ?? defaultSchedule;
    this.cancelFrame = opts.cancel ?? defaultCancel;
  }

  run(arg: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof arg === "function" ? arg() : arg, undefined, 1);
    return () => this.cancel(a);
  }

  stop(): void {
    this.cancelFrame(this.rafId);
    this.rafId = 0;
    this.lastFrame = 0;
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
    this.kick();
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

  private kick(): void {
    if (this.rafId !== 0 || this.active.length === 0) return;
    if (performance.now() - this.lastFrame > FRAME_CAP_MS) this.lastFrame = 0;
    this.rafId = this.schedule(this.frame);
  }

  private frame = (now: number): void => {
    this.rafId = 0;
    try {
      const dt = this.lastFrame === 0 ? 0
        : Math.min(now - this.lastFrame, FRAME_CAP_MS) / 1000;
      this.lastFrame = now;
      this.step(dt);
    } finally { this.kick(); }
  };

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

export function* drive(step: (dt: number, t: number) => boolean | void): Animator {
  let t = 0;
  while (true) {
    const dt = yield;
    t += dt;
    if (step(dt, t) === false) return;
  }
}
