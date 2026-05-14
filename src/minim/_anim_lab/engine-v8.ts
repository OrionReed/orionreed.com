// v8 — v6 + G1: `suspend(impl)` without a wrapping generator.
//
// Today every `yield* suspend(impl)` allocates a fresh generator that
// exists only to deliver `impl` and box the wake payload. v8 returns
// a hand-rolled two-phase iterator instead — no V8 generator machine
// state, no `{value, done}` allocation per .next() (we reuse one).
//
// User code stays identical:
//
//     const v = yield* suspend<T>((wake) => { ... });
//
// `yield*` calls `[Symbol.iterator]()`, then `.next()` repeatedly. We
// implement that by hand:
//   • first .next()  → { value: impl,   done: false }   (engine sees a SuspendFn)
//   • second .next(payload) → { value: payload, done: true }  (yield* return)

const FRAME_CAP_MS = 32;

export interface RuntimeAccess {
  onFrame(cb: (dt: number, t: number) => void): () => void;
}

export type SpawnFn = <R>(
  gen: Animator<R>,
  onComplete?: (value: R) => void,
  scale?: number | (() => number),
) => () => void;

export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (value: T) => void,
  spawn: SpawnFn,
  runtime: RuntimeAccess,
) => () => void;

// Allocation-free suspend. Reuses one frozen iterator-result per phase.
const RESULT_DONE_VOID = Object.freeze({ value: undefined, done: true });
class SuspendIter<T> {
  phase = 0;
  payload: T | undefined = undefined;
  // Re-used per yield: NOT frozen because `value` may change.
  private result = { value: undefined as any, done: false as boolean };
  constructor(readonly impl: SuspendFn<T>) {}
  next(v?: any): { value: any; done: boolean } {
    if (this.phase === 0) {
      this.phase = 1;
      this.result.value = this.impl;
      this.result.done = false;
      return this.result;
    }
    this.result.value = v;
    this.result.done = true;
    return this.result;
  }
  return(v?: any): { value: any; done: boolean } {
    this.phase = 2;
    return RESULT_DONE_VOID as any;
  }
  throw(e: unknown): never { throw e; }
  [Symbol.iterator]() { return this; }
}

export function suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return new SuspendIter(impl) as unknown as Animator<T>;
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
  spawn?(id: number, parentId: number | undefined, clock: number, gen: Animator<any>): void;
  complete?(id: number, clock: number): void;
  cancel?(id: number, clock: number): void;
}

const READY = 0;
const SLEEPING = 1;
const PARKED = 2;
const DEAD = 3;

class Active {
  state: number = READY;
  wakeAt: number = 0;
  dispose: (() => void) | undefined = undefined;
  onComplete: ((value: unknown) => void) | undefined = undefined;
  observeId: number = 0;
  scale: number | (() => number) = 1;
  effScale: number = 1;
  clock: number = 0;
  children: Active[] | undefined = undefined;
  siblingIdx: number = -1;
  constructor(
    readonly gen: Animator<any>,
    readonly parent: Active | undefined,
  ) {}
}

class Ticker {
  alive = true;
  t = 0;
  constructor(
    readonly host: Active | undefined,
    readonly cb: (dt: number, t: number) => void,
  ) {}
}

export const isGen = (v: unknown): v is Animator<any> =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Animator<any>).next === "function";

export function asGen(v: Yieldable): Animator<any> {
  if (isGen(v)) return v;
  return (function* () { yield v; })();
}

export class Anim implements RuntimeAccess {
  private active: Active[] = [];
  private tickers: Ticker[] = [];
  private rafId = 0;
  private _clockMs = 0;
  private lastFrame = 0;
  private clockListeners: Array<(t: number) => void> | undefined;
  private nextActiveId = 0;
  private pendingReturns: Array<Animator<any>> | undefined;
  private inAdvance = 0;
  private subscribingHost: Active | undefined = undefined;
  private hasScale = false;
  private deadSeen = 0;

  observer: AnimObserver | undefined = undefined;

  get clockMs(): number { return this._clockMs; }

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

  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t = new Ticker(this.subscribingHost, cb);
    this.tickers.push(t);
    this.kick();
    return () => { t.alive = false; };
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
    for (const a of this.active.slice()) {
      if (a.state !== DEAD) this.cancel(a);
    }
    this.active.length = 0;
    for (const t of this.tickers) t.alive = false;
    this.tickers.length = 0;
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
    const deadBefore = this.deadSeen;
    if (this.hasScale) {
      for (let i = 0; i < len; i++) {
        const a = arr[i];
        if (a.state === DEAD) continue;
        const s = a.scale;
        const own = typeof s === "number" ? s : s();
        a.effScale = (a.parent ? a.parent.effScale : 1) * own;
        const scaled = dt * a.effScale;
        a.clock += scaled;
        const st = a.state;
        if (st === READY) this.advance(a, scaled);
        else if (st === SLEEPING && a.clock >= a.wakeAt) {
          a.state = READY;
          this.advance(a, undefined);
        }
      }
    } else {
      for (let i = 0; i < len; i++) {
        const a = arr[i];
        const st = a.state;
        if (st === READY) {
          a.clock += dt;
          this.advance(a, dt);
        } else if (st === SLEEPING) {
          a.clock += dt;
          if (a.clock >= a.wakeAt) {
            a.state = READY;
            this.advance(a, undefined);
          }
        }
      }
    }
    if (this.deadSeen !== deadBefore) this.compactActives();

    const ts = this.tickers;
    if (ts.length > 0) {
      let w = 0;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (!t.alive) continue;
        const host = t.host;
        if (host && host.state === DEAD) { t.alive = false; continue; }
        const scaled = host ? dt * host.effScale : dt;
        t.t += scaled;
        t.cb(scaled, t.t);
        if (!t.alive) continue;
        if (i !== w) ts[w] = t;
        w++;
      }
      ts.length = w;
    }
  }

  private compactActives(): void {
    const arr = this.active;
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.state === DEAD) continue;
      if (i !== w) arr[w] = a;
      w++;
    }
    arr.length = w;
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
      this.hasScale = true;
    }
    if (this.hasScale) {
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

  private detach(a: Active): void {
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

  private cancel(a: Active): void {
    if (a.state === DEAD) return;
    const wasParked = a.state === PARKED;
    a.state = DEAD;
    this.deadSeen++;
    if (this.observer?.cancel && a.observeId !== 0) {
      this.observer.cancel(a.observeId, this._clockMs);
    }
    if (wasParked) {
      const d = a.dispose;
      a.dispose = undefined;
      if (d) d();
    }
    this.detach(a);
    const cs = a.children;
    if (cs) {
      a.children = undefined;
      for (let i = 0; i < cs.length; i++) cs[i].siblingIdx = -1;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c.state !== DEAD) this.cancel(c);
      }
    }
    this.scheduleReturn(a.gen);
  }

  private scheduleReturn(g: Animator<any>): void {
    if (this.inAdvance > 0) {
      if (!this.pendingReturns) this.pendingReturns = [g];
      else this.pendingReturns.push(g);
    } else {
      g.return(undefined);
    }
  }

  private drainPendingReturns(): void {
    const q = this.pendingReturns;
    if (!q) return;
    this.pendingReturns = undefined;
    for (let i = 0; i < q.length; i++) q[i].return(undefined);
  }

  private kick(): void {
    if (this.rafId !== 0 || (this.active.length === 0 && this.tickers.length === 0)) return;
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
    const prevHost = this.subscribingHost;
    this.subscribingHost = a;
    let dispose: () => void;
    try {
      dispose = impl(wake, spawn, this);
    } finally {
      this.subscribingHost = prevHost;
    }
    setupActive = false;
    if (resumed || a.state === DEAD) {
      dispose();
    } else {
      a.state = PARKED;
      a.dispose = dispose;
    }
  }

  private suspendOnChildren(a: Active, children: Yieldable[]): void {
    if (children.length === 0) {
      this.advance(a, undefined);
      return;
    }
    let left = children.length;
    a.state = PARKED;
    const onChild = () => {
      if (--left === 0 && a.state === PARKED) {
        a.state = READY;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < children.length; j++) {
      if (a.state === DEAD) return;
      this.spawn(asGen(children[j]), a, onChild);
    }
  }

  private advance(a: Active, resume: unknown): void {
    this.inAdvance++;
    try {
      let result = a.gen.next(resume as number);
      while (!result.done) {
        if (a.state === DEAD) return;
        const v = result.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) {
            a.state = SLEEPING;
            a.wakeAt = a.clock + v;
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
          this.suspendOnChildren(a, v);
          return;
        }
        this.suspendOnChildren(a, [v as Animator<any>]);
        return;
      }
      if (a.state === DEAD) return;
      a.state = DEAD;
      this.deadSeen++;
      this.detach(a);
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
        this.deadSeen++;
        this.detach(a);
      }
    } finally {
      this.inAdvance--;
      if (this.inAdvance === 0) this.drainPendingReturns();
    }
  }
}

export function drive(
  step: (dt: number, t: number) => boolean | void,
): Animator {
  return suspend<void>((wake, _spawn, anim) => {
    return anim.onFrame((dt, t) => {
      if (step(dt, t) === false) wake();
    });
  });
}
