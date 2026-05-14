// v9 — Minimal. Smallest correct engine that still honours the yield
// contract. The DS/algo simplifications:
//
// (1) State as a single number.
//     `wakeAt` doubles as "what state am I in":
//        0         → READY this step
//        +Number   → SLEEPING; advance when own-clock reaches it
//        Infinity  → PARKED (suspended; only `wake`/`onChild` revives)
//        and `done: boolean` flags DEAD.
//     Dispatching reduces to one comparison per step per active.
//
// (2) yield child === yield [child].
//     `suspendOnChildren` handles both — saves a method.
//
// (3) Static scale only.
//     Reactive scale was a per-step parent-chain walk. Static scale is
//     resolved once at spawn (`effScale = parent.effScale × own`) and
//     never changes. `.at(reactiveSig)` becomes the user's job (wrap
//     the inner gen and re-spawn on change). 99% of `.at()` use is a
//     literal number; this hits the common case directly.
//
// (4) No observer hook.
//     The trace/assert layer can wrap `Anim`'s methods externally.
//     Built-in observer was three optional callbacks + `observeId` per
//     active. ~30 lines for a debug feature.
//
// (5) No ticker primitive.
//     Drive-style work runs through the generator path uniformly. v6
//     was 4× faster on `drive-loop` because of tickers; v9 is slower
//     there but smaller. Trade explicit; user can layer tickers back
//     in if perf demands it.
//
// (6) Linear `parent.children` detach (no siblingIdx).
//     Parent.children kept for O(1) cancel cascade (the v3 win); detach
//     on natural completion / cancel walks the array. Sibling counts
//     are tiny (1 typical, ≤10 for parallel) so O(siblings) is fine.
//
// (7) Single re-entrancy flag (`inAdvance` + `pendingReturn`) per
//     active — cheaper than a queue for the common single-cancel case.

const FRAME_CAP_MS = 32;

export type SpawnFn = <R>(
  g: Animator<R>,
  onComplete?: (v: R) => void,
  scale?: number,
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
  // wakeAt: 0=ready, >0=sleeping (own-clock target), Infinity=parked.
  wakeAt = 0;
  clock = 0;
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
    scale: number,
  ) {
    this.effScale = (parent ? parent.effScale : 1) * scale;
  }
}

export class Anim {
  private active: Active[] = [];
  private rafId = 0;
  private _clockMs = 0;
  private lastFrame = 0;

  get clockMs(): number { return this._clockMs; }

  run(arg: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof arg === "function" ? arg() : arg, undefined, 1);
    return () => this.cancel(a);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0; this.lastFrame = 0; this._clockMs = 0;
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
      a.clock += dt * a.effScale;
      // Single dispatch: wakeAt <= clock means READY (0) or SLEEPING-just-expired.
      if (a.wakeAt <= a.clock) {
        a.wakeAt = 0;
        this.advance(a, dt * a.effScale);
      }
      if (!a.done) { if (i !== w) arr[w] = a; w++; }
    }
    arr.length = w;
  }

  private spawn(
    g: Animator<any>,
    parent: Active | undefined,
    scale: number,
    onComplete?: (v: unknown) => void,
  ): Active {
    const a = new Active(g, parent, scale);
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
    if (a.parent && a.parent.children) {
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
    this.rafId = requestAnimationFrame(this.frame);
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
        if (typeof v === "function") { this.subscribe(a, v as SuspendFn<any>); return; }
        // yield gen / yield [gens] — fused. Empty array is sync-complete.
        const kids = Array.isArray(v) ? v : [v];
        if (kids.length === 0) { r = a.gen.next(0); continue; }
        let left = kids.length;
        a.wakeAt = Infinity;
        const onChild = () => {
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
      // Natural complete.
      if (a.done) return;
      a.done = true;
      if (a.parent && a.parent.children) {
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

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false, setupOk = true;
    const wake = (v?: unknown) => {
      if (resumed || a.done) return;
      resumed = true;
      const d = a.dispose; a.dispose = undefined;
      a.wakeAt = 0;
      if (d) d();
      this.advance(a, v);
    };
    const spawn: SpawnFn = (g, oc, sc) => {
      if (!setupOk) throw new Error("minim: spawn() valid only during suspend setup");
      const c = this.spawn(g, a, sc ?? 1, oc as any);
      return () => this.cancel(c);
    };
    const dispose = impl(wake, spawn);
    setupOk = false;
    if (resumed || a.done) dispose();
    else { a.wakeAt = Infinity; a.dispose = dispose; }
  }
}
