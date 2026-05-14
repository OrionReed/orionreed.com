// v10 — Pushing v9 further. Stripped to the algorithmic core.
//
// Additional cuts vs v9:
//
// (a) No scale in the runtime at all.
//     Spawn() loses its `scale` parameter. `.at(scale)` becomes a
//     userland combinator that wraps a gen and intercepts dt at the
//     yield boundaries it owns. (Doesn't propagate into nested gens
//     transparently — but reactive scale already didn't either.)
//     Removes ~10 lines and one float per Active.
//
// (b) RAF/clock decoupled from runtime.
//     `Anim` is now a pure stepping engine: `step(dt)` is the only
//     time input. The browser-loop adapter (`drive(anim)`) lives
//     outside in 6 lines (see export at the bottom). This makes the
//     engine trivially headless / Node-friendly / test-friendly and
//     removes ~20 lines of rAF plumbing from the core.
//
// (c) `subscribe` inlined into `advance`.
//     Removes a method boundary and a tiny dance. The two non-trivial
//     suspend kinds (callback-wake vs child-wait) read top-to-bottom
//     in one place.

const FRAME_CAP_MS = 32;

export type SpawnFn = <R>(g: Animator<R>, onComplete?: (v: R) => void) => () => void;

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
  // wakeAt: 0=ready, >0=sleeping (clock target), Infinity=parked.
  wakeAt = 0;
  clock = 0;
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
  private _clockMs = 0;

  get clockMs(): number { return this._clockMs; }

  run(arg: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof arg === "function" ? arg() : arg, undefined);
    return () => this.cancel(a);
  }

  stop(): void {
    this._clockMs = 0;
    for (const a of this.active.slice()) this.cancel(a);
    this.active.length = 0;
  }

  step(dt: number): void {
    if (dt > 0) this._clockMs += dt;
    const arr = this.active;
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.done) continue;
      a.clock += dt;
      if (a.wakeAt <= a.clock) {
        a.wakeAt = 0;
        this.advance(a, dt);
      }
      if (!a.done) { if (i !== w) arr[w] = a; w++; }
    }
    arr.length = w;
  }

  private spawn(
    g: Animator<any>,
    parent: Active | undefined,
    onComplete?: (v: unknown) => void,
  ): Active {
    const a = new Active(g, parent);
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
          // ── Inlined subscribe (callback-driven wake) ──
          let resumed = false, setupOk = true;
          const wake = (val?: unknown): void => {
            if (resumed || a.done) return;
            resumed = true;
            const d = a.dispose; a.dispose = undefined;
            a.wakeAt = 0;
            if (d) d();
            this.advance(a, val);
          };
          const spawn: SpawnFn = (g, oc) => {
            if (!setupOk) throw new Error("minim: spawn() valid only during suspend setup");
            const c = this.spawn(g, a, oc as any);
            return () => this.cancel(c);
          };
          const dispose = (v as SuspendFn<any>)(wake, spawn);
          setupOk = false;
          if (resumed || a.done) dispose();
          else { a.wakeAt = Infinity; a.dispose = dispose; }
          return;
        }
        // ── Child / array of children — fused ──
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
          this.spawn(isGen(k) ? k : (function*() { yield k as any; })(), a, onChild);
        }
        return;
      }
      // Natural complete.
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

// ── Browser RAF adapter ──────────────────────────────────────────────
//
// Lives outside the engine: `Anim` itself is pure stepping. Returns a
// disposer to stop the loop. Headless / test code just calls
// `anim.step(dt)` directly and ignores this.

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
  return () => {
    cancelAnimationFrame(rafId);
    rafId = 0;
  };
}
