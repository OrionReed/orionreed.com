// v3 — Best of both: keep current's single-array structure (cheap
// for sleep + parallel + every other path) but add the two
// optimizations that make v2 fly on the hot paths:
//
//   (a) parent.children list → O(1) cascade cancel instead of O(N)
//       per-cancel scan. (Big win for spawn+cancel and stop().)
//   (b) scaledCount / sleepingCount gating → skip whole branches of
//       per-step work when nobody uses scale or is sleeping. (Win
//       for drive-loop hot path.)
//
// Plus minor tidying: clockListeners as array, inlined complete(),
// observeId only when an observer is set, and lazy compaction with
// a deadCount threshold.
//
// Yield contract: identical to engine-current (verified by equiv.ts).

const FRAME_CAP_MS = 32;

export type SpawnFn = <R>(
  gen: Animator<R>,
  onComplete?: (value: R) => void,
  scale?: number | (() => number),
) => () => void;

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (value: T) => void,
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

export interface AnimObserver {
  spawn?(
    id: number,
    parentId: number | undefined,
    clock: number,
    gen: Animator<any>,
  ): void;
  complete?(id: number, clock: number): void;
  cancel?(id: number, clock: number): void;
}

const READY = 0;
const SLEEPING = 1;
const SUBSCRIBED = 2;
const WAITING = 3;
const DEAD = 4;

class Active {
  state: number = READY;
  wakeAt: number = 0;
  dispose: (() => void) | undefined = undefined;
  onComplete: ((value: unknown) => void) | undefined = undefined;
  onStack: boolean = false;
  pendingReturn: boolean = false;
  observeId: number = 0;
  scale: number | (() => number) = 1;
  effScale: number = 1;
  clock: number = 0;
  // Lazily allocated; only spawn assigns it. Used for O(1) cascade
  // cancel — we walk parent.children directly instead of scanning the
  // global active[] looking for `child.parent === a`.
  children: Active[] | undefined = undefined;
  // Index of self in parent.children. Used for O(1) detach on
  // complete/cancel; meaningless when parent is undefined.
  siblingIdx: number = -1;
  constructor(
    readonly gen: Animator<any>,
    readonly parent: Active | undefined,
  ) {}
}

// O(1) swap-remove of `a` from `parent.children`, using the cached
// `siblingIdx`. Called on natural completion AND cancel so long-lived
// parents (e.g. a `loop` that repeatedly spawns short children) don't
// accumulate dead refs.
function detachFromParent(a: Active): void {
  const p = a.parent;
  if (!p) return;
  const cs = p.children;
  if (!cs) return;
  const i = a.siblingIdx;
  if (i < 0) return;
  const last = cs.length - 1;
  if (i !== last) {
    const moved = cs[last];
    cs[i] = moved;
    moved.siblingIdx = i;
  }
  cs.length = last;
  a.siblingIdx = -1;
}

export const isGen = (v: unknown): v is Animator<any> =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Animator<any>).next === "function";

export function asGen(v: Yieldable): Animator<any> {
  if (isGen(v)) return v;
  return (function* () {
    yield v;
  })();
}

export class Anim {
  private active: Active[] = [];
  private deadCount = 0;
  private rafId = 0;
  private _clockMs = 0;
  private lastFrame = 0;
  private clockListeners: Array<(t: number) => void> | undefined;
  private nextActiveId = 0;
  // Gating counters: when 0, skip the corresponding hot-path work.
  private scaledCount = 0;
  private sleepingCount = 0;

  observer: AnimObserver | undefined = undefined;

  get clockMs(): number {
    return this._clockMs;
  }

  onClock(cb: (t: number) => void): () => void {
    if (!this.clockListeners) this.clockListeners = [cb];
    else this.clockListeners.push(cb);
    return () => {
      const ls = this.clockListeners;
      if (!ls) return;
      const i = ls.indexOf(cb);
      if (i >= 0) ls.splice(i, 1);
      if (ls.length === 0) this.clockListeners = undefined;
    };
  }

  run(arg: Animator<any> | (() => Animator<any>)): () => void {
    const gen = typeof arg === "function" ? arg() : arg;
    const a = this.spawn(gen);
    return () => this.cancel(a);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.lastFrame = 0;
    this._clockMs = 0;
    // Walk a snapshot — cancel mutates active[] indirectly via cascade.
    for (const a of this.active.slice()) {
      if (a.state !== DEAD) this.cancel(a);
    }
    this.active.length = 0;
    this.deadCount = 0;
  }

  step(dt: number): void {
    if (dt > 0) {
      this._clockMs += dt;
      const ls = this.clockListeners;
      if (ls) {
        const c = this._clockMs;
        for (let i = 0; i < ls.length; i++) ls[i](c);
      }
    }

    const arr = this.active;
    const len = arr.length;
    const hasScale = this.scaledCount > 0;
    const anySleep = this.sleepingCount > 0;

    if (hasScale) {
      // Scale chain refresh in spawn order. Walks all alive actives so
      // descendants inherit fresh parent.effScale.
      for (let i = 0; i < len; i++) {
        const a = arr[i];
        if (a.state === DEAD) continue;
        const s = a.scale;
        const own = typeof s === "number" ? s : s();
        a.effScale = (a.parent ? a.parent.effScale : 1) * own;
        const scaled = dt * a.effScale;
        a.clock += scaled;
        const st = a.state;
        if (st === READY) {
          this.advance(a, scaled);
        } else if (st === SLEEPING && a.clock >= a.wakeAt) {
          a.state = READY;
          this.sleepingCount--;
          this.advance(a, undefined);
        }
      }
    } else if (anySleep) {
      // No scale; some sleepers. effScale is 1 throughout.
      for (let i = 0; i < len; i++) {
        const a = arr[i];
        const st = a.state;
        if (st === DEAD) continue;
        a.clock += dt;
        if (st === READY) {
          this.advance(a, dt);
        } else if (st === SLEEPING && a.clock >= a.wakeAt) {
          a.state = READY;
          this.sleepingCount--;
          this.advance(a, undefined);
        }
      }
    } else {
      // Fastest path: no scale, no sleeps. Only READY actives do work.
      for (let i = 0; i < len; i++) {
        const a = arr[i];
        const st = a.state;
        if (st === READY) {
          a.clock += dt;
          this.advance(a, dt);
        }
        // SUBSCRIBED / WAITING / DEAD: no per-step work.
      }
    }

    if (this.deadCount > 16 && this.deadCount * 2 >= this.active.length) {
      this.compact();
    }
  }

  private compact(): void {
    const arr = this.active;
    let w = 0;
    for (let r = 0; r < arr.length; r++) {
      const a = arr[r];
      if (a.state !== DEAD) {
        if (r !== w) arr[w] = a;
        w++;
      }
    }
    arr.length = w;
    this.deadCount = 0;
  }

  private spawn(
    gen: Animator<any>,
    parent?: Active,
    onComplete?: (value: unknown) => void,
    scale?: number | (() => number),
  ): Active {
    const a = new Active(gen, parent);
    a.onComplete = onComplete;
    if (scale !== undefined && scale !== 1) {
      a.scale = scale;
      this.scaledCount++;
    }
    if (this.scaledCount > 0) {
      const s = a.scale;
      const own = typeof s === "number" ? s : s();
      a.effScale = (parent ? parent.effScale : 1) * own;
    }
    if (parent) {
      let cs = parent.children;
      if (!cs) cs = parent.children = [];
      a.siblingIdx = cs.length;
      cs.push(a);
    }
    this.active.push(a);
    if (this.observer?.spawn) {
      a.observeId = ++this.nextActiveId;
      this.observer.spawn(
        a.observeId,
        parent && parent.observeId !== 0 ? parent.observeId : undefined,
        this._clockMs,
        gen,
      );
    }
    this.advance(a, undefined);
    this.kick();
    return a;
  }

  private cancel(a: Active): void {
    if (a.state === DEAD) return;
    const wasSubscribed = a.state === SUBSCRIBED;
    const wasSleeping = a.state === SLEEPING;
    a.state = DEAD;
    this.deadCount++;
    if (wasSleeping) this.sleepingCount--;
    if (a.scale !== 1) this.scaledCount--;
    if (this.observer?.cancel && a.observeId !== 0) {
      this.observer.cancel(a.observeId, this._clockMs);
    }
    if (wasSubscribed) {
      const d = a.dispose!;
      a.dispose = undefined;
      d();
    }
    detachFromParent(a);
    const cs = a.children;
    if (cs) {
      a.children = undefined;
      // Null out siblingIdx so the recursive cancel on each child
      // doesn't try to write back into our (now-detached) array.
      for (let i = 0; i < cs.length; i++) cs[i].siblingIdx = -1;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c.state !== DEAD) this.cancel(c);
      }
    }
    if (a.onStack) {
      a.pendingReturn = true;
      return;
    }
    a.gen.return(undefined);
  }

  private kick(): void {
    if (this.rafId !== 0 || this.active.length === 0) return;
    if (performance.now() - this.lastFrame > FRAME_CAP_MS) this.lastFrame = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (rafNow: number): void => {
    this.rafId = 0;
    try {
      const dt =
        this.lastFrame === 0
          ? 0
          : Math.min(rafNow - this.lastFrame, FRAME_CAP_MS) / 1000;
      this.lastFrame = rafNow;
      this.step(dt);
    } finally {
      this.kick();
    }
  };

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    let setupActive = true;
    const wake = (value?: unknown) => {
      if (resumed || a.state === DEAD) return;
      resumed = true;
      const d = a.dispose;
      a.state = READY;
      a.dispose = undefined;
      if (d) d();
      this.advance(a, value);
    };
    const spawn: SpawnFn = <R>(
      gen: Animator<R>,
      onComplete?: (value: R) => void,
      scale?: number | (() => number),
    ) => {
      if (!setupActive) {
        throw new Error("minim: spawn() valid only during suspend setup");
      }
      const child = this.spawn(
        gen,
        a,
        onComplete as ((value: unknown) => void) | undefined,
        scale,
      );
      return () => this.cancel(child);
    };
    const dispose = impl(wake, spawn);
    setupActive = false;
    if (resumed || a.state === DEAD) {
      dispose();
    } else {
      a.state = SUBSCRIBED;
      a.dispose = dispose;
    }
  }

  private suspendSleep(a: Active, sec: number): void {
    a.state = SLEEPING;
    a.wakeAt = a.clock + sec;
    this.sleepingCount++;
  }

  private suspendAll(a: Active, children: Yieldable[]): void {
    if (children.length === 0) {
      this.advance(a, undefined);
      return;
    }
    let left = children.length;
    a.state = WAITING;
    const onChild = () => {
      if (--left === 0 && a.state === WAITING) {
        a.state = READY;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < children.length; j++) {
      if (a.state === DEAD) return;
      this.spawn(asGen(children[j]), a, onChild);
    }
  }

  private suspendChild(a: Active, gen: Animator<any>): void {
    a.state = WAITING;
    this.spawn(gen, a, () => {
      if (a.state === WAITING) {
        a.state = READY;
        this.advance(a, undefined);
      }
    });
  }

  private advance(a: Active, resume: unknown): void {
    a.onStack = true;
    try {
      let result = a.gen.next(resume as number);
      while (!result.done) {
        if (a.state === DEAD) return;
        const v = result.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) {
            this.suspendSleep(a, v);
            return;
          }
          result = a.gen.next(0);
          continue;
        }
        if (typeof v === "function") {
          this.subscribe(a, v as SuspendFn<any>);
          return;
        }
        if (Array.isArray(v)) {
          this.suspendAll(a, v);
          return;
        }
        this.suspendChild(a, v as Animator<any>);
        return;
      }
      // Inlined complete().
      if (a.state === DEAD) return;
      a.state = DEAD;
      this.deadCount++;
      if (a.scale !== 1) this.scaledCount--;
      // Inline detach: avoid the call-overhead in the hot completion
      // path (parallel-tuple completes, fluent .then chains, etc.).
      const p = a.parent;
      if (p) {
        const cs = p.children;
        if (cs) {
          const i = a.siblingIdx;
          if (i >= 0) {
            const last = cs.length - 1;
            if (i !== last) {
              const moved = cs[last];
              cs[i] = moved;
              moved.siblingIdx = i;
            }
            cs.length = last;
          }
        }
      }
      if (this.observer?.complete && a.observeId !== 0) {
        this.observer.complete(a.observeId, this._clockMs);
      }
      const cb = a.onComplete;
      if (cb) {
        a.onComplete = undefined;
        cb(result.value);
      }
    } catch (e) {
      console.error("minim: animator threw", e);
      if (a.state !== DEAD) {
        a.state = DEAD;
        this.deadCount++;
        if (a.scale !== 1) this.scaledCount--;
        detachFromParent(a);
      }
    } finally {
      a.onStack = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        a.gen.return(undefined);
      }
    }
  }
}
