// v4 — Architectural reframe: tickers as a first-class runtime primitive.
//
// Insight: the most common workload by far is "do a thing every frame
// with `dt`". Today that flows through a generator (`drive(step)` is
// `while(true) { dt = yield; step(dt) }`). Each frame: generator
// allocation + state machine + `gen.next()` overhead per active. For
// 1000 spring/oscillate/drift behaviours, this is the dominant cost.
//
// v4 exposes an internal `onFrame(cb): dispose` registry. A SuspendFn
// can register a per-frame callback and call `wake()` from inside it
// to complete. `drive` (re-implemented here as a thin wrapper) becomes:
//
//   function* drive(step) {
//     return yield* suspend((wake, _spawn, anim) => {
//       let t = 0;
//       return anim.onFrame((dt) => {
//         t += dt;
//         if (step(dt, t) === false) wake();
//       });
//     });
//   }
//
// Now 1000 drives = 1000 callbacks in a flat array, called per frame.
// No generators at all in the steady state. The generator runtime only
// spins for orchestration (sleep, parallel, suspend).
//
// SuspendFn signature gains a third `anim` parameter exposing onFrame.
// Existing impls that take only (wake, spawn) keep working — the third
// arg is ignored.

const FRAME_CAP_MS = 32;

export interface RuntimeAccess {
  /** Register a per-frame callback. Returns a disposer. The callback
   *  receives `dt` (in seconds, scaled by the host suspension's effective
   *  scale) and the accumulated `t` since registration. Inherits the
   *  scale of the host active if used inside a suspend. */
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

export interface AnimObserver {
  spawn?(id: number, parentId: number | undefined, clock: number, gen: Animator<any>): void;
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
  children: Active[] | undefined = undefined;
  siblingIdx: number = -1;
  constructor(
    readonly gen: Animator<any>,
    readonly parent: Active | undefined,
  ) {}
}

// One per-frame ticker registration. `host` lets us scale dt by the
// host suspension's effective scale (and skip if host is dead).
class Ticker {
  alive = true;
  t = 0;
  constructor(
    readonly host: Active | undefined,
    readonly cb: (dt: number, t: number) => void,
  ) {}
}

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
  return (function* () { yield v; })();
}

export class Anim implements RuntimeAccess {
  private active: Active[] = [];
  private deadCount = 0;
  private rafId = 0;
  private _clockMs = 0;
  private lastFrame = 0;
  private clockListeners: Array<(t: number) => void> | undefined;
  private nextActiveId = 0;
  private scaledCount = 0;
  private sleepingCount = 0;
  // The flat ticker registry. Compact-on-step.
  private tickers: Ticker[] = [];
  // The active currently being subscribed (if any). New tickers
  // registered during a SuspendFn impl get this as their host so
  // scale + cancel cascade flow correctly.
  private subscribingHost: Active | undefined = undefined;

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

  /** Register a per-frame callback. If called from inside a SuspendFn
   *  (the common case), the host's effective scale and lifecycle apply.
   *  Outside a suspend, the ticker runs at root rate until disposed. */
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
    this.deadCount = 0;
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
    const hasScale = this.scaledCount > 0;
    const anySleep = this.sleepingCount > 0;

    if (hasScale) {
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
      for (let i = 0; i < len; i++) {
        const a = arr[i];
        if (a.state === READY) {
          a.clock += dt;
          this.advance(a, dt);
        }
      }
    }

    // Tick callbacks. Hot loop is dead-simple: skip non-alive (host
    // died or disposed), compute scaled dt, call cb. Compact in-place.
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
        if (!t.alive) continue; // cb may have disposed itself
        if (i !== w) ts[w] = ts[i];
        w++;
      }
      ts.length = w;
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
    // Host newly-registered tickers to `a` so scale + cancel cascade
    // flow correctly. Restored after impl returns.
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
      if (a.state === DEAD) return;
      a.state = DEAD;
      this.deadCount++;
      if (a.scale !== 1) this.scaledCount--;
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

// ── drive() — re-implemented on top of onFrame for v4 only ───────────
//
// Bypasses the generator-per-frame state machine entirely. The host
// active becomes SUBSCRIBED on the suspend; the per-frame callback runs
// from the ticker registry. wake() (calling step → false) returns to
// the parent generator normally.

export function drive(
  step: (dt: number, t: number) => boolean | void,
): Animator {
  return suspend<void>((wake, _spawn, anim) => {
    return anim.onFrame((dt, t) => {
      if (step(dt, t) === false) wake();
    });
  });
}
