// v1 — Conservative optimizations on top of the current shape.
//
// Same structural design as engine-current (single Active[] array,
// state-machine per active). Targeted wins:
//
//   1. Gate scale subsystem behind `scaledCount`. When zero, skip the
//      per-active typeof + parent-deref + multiply entirely. The vast
//      majority of actives don't use .at(), so this is the dominant
//      hot path.
//   2. Skip the SLEEPING check when sleepingCount === 0.
//   3. Replace clockListeners Set with a plain array (most Anims have
//      0 or 1 listeners; the Set add/iter cost dominates for tiny N).
//   4. Inline complete() into advance() epilogue.
//   5. Lazy compaction — only when deadCount exceeds threshold.
//   6. Drop the per-Active observeId field unless an observer is set.
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
  // Per-Active scale; only consulted when scaledCount > 0.
  scale: number | (() => number) = 1;
  effScale: number = 1;
  clock: number = 0;
  constructor(
    readonly gen: Animator<any>,
    readonly parent: Active | undefined,
  ) {}
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
  // Plain array — usual case is 0 or 1 listeners.
  private clockListeners: Array<(t: number) => void> | undefined;
  private nextActiveId = 0;
  // Counters that gate optional work.
  private scaledCount = 0; // # actives whose own scale ≠ static 1
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
    for (const a of this.active.slice()) this.cancel(a);
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
      // Slow path: refresh scale chain in spawn order.
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
      // Fast path with sleep checks. effScale already 1 for all.
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
      // Fastest path: no scale, no sleeps. Just advance READY actives.
      for (let i = 0; i < len; i++) {
        const a = arr[i];
        const st = a.state;
        if (st === READY) {
          a.clock += dt;
          this.advance(a, dt);
        } else if (st === DEAD) {
          continue;
        }
        // SUBSCRIBED / WAITING — no work to do.
      }
    }

    // Lazy compaction: only when dead density warrants it.
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
    const arr = this.active;
    for (let i = 0; i < arr.length; i++) {
      const child = arr[i];
      if (child.parent === a && child.state !== DEAD) this.cancel(child);
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
