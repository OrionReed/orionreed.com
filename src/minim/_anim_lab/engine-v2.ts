// v2 — Structural reframe.
//
// Key idea: only iterate actives that need work this step. Parked
// actives (subscribed / waiting on children) sit in `parked`, kept
// alive by closure refs; they're never iterated per-step. Sleepers
// live in `sleepers`, scanned for wake-time. READY actives live in
// `ready`, the sole hot loop.
//
// State transitions:
//   ready  ──yield N>0──▶ sleepers
//   ready  ──yield fn──▶  parked (with dispose)
//   ready  ──yield arr/gen──▶ parked (waits for child wake, no dispose)
//   sleepers ──clock≥wakeAt──▶ ready
//   parked ──wake()──▶ ready
//   any   ──cancel/complete──▶ removed
//
// Scale subsystem: same gating trick as v1 — when scaledCount === 0
// the entire scale path is skipped. When > 0, we refresh effScale
// in spawn-order across all live actives (because parked parents may
// have descendants in `ready` reading their scale chain). Parents
// always precede children because spawn order is preserved.
//
// We drop the WAITING/SUBSCRIBED distinction (both "parked, will be
// woken"); the disposer is `undefined` for child-wait. The
// `onStack`/`pendingReturn` re-entrancy guard collapses to a single
// boolean since cancel is the only re-entrant path that calls
// `gen.return()`.

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

// State just for the "what list am I in / what to do on cancel".
const READY = 0;
const SLEEPING = 1;
const PARKED = 2; // subscribed OR waiting-on-children
const DEAD = 3;

interface Active {
  state: number;
  wakeAt: number;
  dispose: (() => void) | undefined;
  onComplete: ((value: unknown) => void) | undefined;
  onStack: boolean;
  pendingReturn: boolean;
  observeId: number;
  scale: number | (() => number);
  effScale: number;
  clock: number;
  // Spawn order — preserved across all lists; used as the comparator
  // when refreshing scale chain (parents have lower order). Filled in
  // by spawn().
  order: number;
  gen: Animator<any>;
  parent: Active | undefined;
  // Children are tracked explicitly so cascade cancel doesn't need to
  // scan the whole world. Lazily allocated; most actives have none.
  children: Active[] | undefined;
}

function makeActive(gen: Animator<any>, parent: Active | undefined): Active {
  // Object literal initializer — keep ALL fields present and same
  // type so V8 picks one hidden class.
  return {
    state: READY,
    wakeAt: 0,
    dispose: undefined,
    onComplete: undefined,
    onStack: false,
    pendingReturn: false,
    observeId: 0,
    scale: 1,
    effScale: 1,
    clock: 0,
    order: 0,
    gen,
    parent,
    children: undefined,
  };
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
  // Live lists: ready iterated each step, sleepers checked each step,
  // parked held only via parent.children + closure refs (no list).
  // `roots` are top-level (parent===undefined); used by stop() to walk
  // the whole tree.
  private ready: Active[] = [];
  private sleepers: Active[] = [];
  private roots: Set<Active> = new Set();
  // Spawn-ordered set for the scale walk. Only consulted when
  // scaledCount > 0; we accept the bookkeeping cost only on that path.
  private scaledScope: Active[] | undefined;
  private scaledCount = 0;

  private rafId = 0;
  private _clockMs = 0;
  private lastFrame = 0;
  private clockListeners: Array<(t: number) => void> | undefined;
  private nextActiveId = 0;
  private nextOrder = 0;

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
    // Cancel all roots; cascade reaches every live descendant.
    const snap = Array.from(this.roots);
    for (const a of snap) this.cancel(a);
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

    // Refresh scale chain across the scoped set in spawn order
    // (only if anyone has a non-1 scale). `scaledScope` is appended-
    // only in spawn order, so no sort required.
    if (this.scaledCount > 0 && this.scaledScope) {
      const scope = this.scaledScope;
      let w = 0;
      for (let i = 0; i < scope.length; i++) {
        const a = scope[i];
        if (a.state === DEAD) continue;
        const s = a.scale;
        const own = typeof s === "number" ? s : s();
        a.effScale = (a.parent ? a.parent.effScale : 1) * own;
        if (i !== w) scope[w] = a;
        w++;
      }
      scope.length = w;
    }

    // Wake sleepers whose time arrived. We tick their clock by dt *
    // effScale (effScale is 1 when no scale).
    if (this.sleepers.length > 0) {
      const sl = this.sleepers;
      let w = 0;
      for (let r = 0; r < sl.length; r++) {
        const a = sl[r];
        if (a.state === DEAD) continue;
        const scaled = dt * a.effScale;
        a.clock += scaled;
        if (a.clock >= a.wakeAt) {
          a.state = READY;
          this.ready.push(a);
        } else {
          if (r !== w) sl[w] = a;
          w++;
        }
      }
      sl.length = w;
    }

    // Hot loop: advance all READY actives. New actives spawned during
    // the loop (parked → ready transitions, or freshly-spawned children)
    // should NOT run this frame; snapshot length.
    const ready = this.ready;
    const len = ready.length;
    let liveCount = 0;
    for (let i = 0; i < len; i++) {
      const a = ready[i];
      if (a.state === DEAD) continue;
      const scaled = dt * a.effScale;
      a.clock += scaled;
      // After advance, state may be READY (one-frame yield), SLEEPING,
      // PARKED, or DEAD. Only state===READY post-advance keeps it in
      // the ready list.
      this.advance(a, scaled);
      if (a.state === READY) liveCount++;
    }
    // Compact: keep READY entries up to `len`, plus everything pushed
    // beyond `len` (children spawned mid-step that are still READY,
    // anything woken from sleep — those are appended).
    if (liveCount !== len) {
      let w = 0;
      for (let r = 0; r < len; r++) {
        const a = ready[r];
        if (a.state === READY) {
          if (r !== w) ready[w] = a;
          w++;
        }
      }
      // Shift the post-len tail down.
      for (let r = len; r < ready.length; r++, w++) ready[w] = ready[r];
      ready.length = w;
    }
  }

  private spawn(
    gen: Animator<any>,
    parent?: Active,
    onComplete?: (value: unknown) => void,
    scale?: number | (() => number),
  ): Active {
    const a = makeActive(gen, parent);
    a.onComplete = onComplete;
    a.order = ++this.nextOrder;
    if (parent) {
      if (!parent.children) parent.children = [a];
      else parent.children.push(a);
    }
    if (scale !== undefined && scale !== 1) {
      a.scale = scale;
      this.scaledCount++;
    }
    if (this.scaledCount > 0) {
      const s = a.scale;
      const own = typeof s === "number" ? s : s();
      a.effScale = (parent ? parent.effScale : 1) * own;
      // Track in scope so future steps refresh effScale even if our
      // own scale is the static 1 (we may inherit from a reactive parent).
      if (!this.scaledScope) this.scaledScope = [];
      this.scaledScope.push(a);
    }
    if (!parent) this.roots.add(a);

    if (this.observer?.spawn) {
      a.observeId = ++this.nextActiveId;
      this.observer.spawn(
        a.observeId,
        parent && parent.observeId !== 0 ? parent.observeId : undefined,
        this._clockMs,
        gen,
      );
    }

    // Initial advance — runs synchronously. After this, `a` is in the
    // appropriate list (or DEAD).
    this.advance(a, undefined);
    if (a.state === READY) this.ready.push(a);
    this.kick();
    return a;
  }

  private cancel(a: Active): void {
    if (a.state === DEAD) return;
    const wasParked = a.state === PARKED;
    a.state = DEAD;
    if (a.scale !== 1) this.scaledCount--;
    if (!a.parent) this.roots.delete(a);
    if (this.observer?.cancel && a.observeId !== 0) {
      this.observer.cancel(a.observeId, this._clockMs);
    }
    if (wasParked) {
      const d = a.dispose;
      a.dispose = undefined;
      if (d) d();
    }
    // Children cascade: walk all live containers. Only PARKED parents
    // can have child references back to them (children spawned via the
    // suspend `spawn` arg always have parent set).
    this.cancelChildrenOf(a);
    if (a.onStack) {
      a.pendingReturn = true;
      return;
    }
    a.gen.return(undefined);
  }

  private cancelChildrenOf(p: Active): void {
    const cs = p.children;
    if (!cs) return;
    p.children = undefined;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (c.state !== DEAD) this.cancel(c);
    }
  }

  private kick(): void {
    if (this.rafId !== 0 || this.ready.length + this.sleepers.length === 0) return;
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
      a.dispose = undefined;
      // Move from PARKED back to READY. If we're still inside the
      // initial subscribe (sync wake), state is still READY (we haven't
      // set PARKED yet), so just advance.
      if (a.state === PARKED) {
        // Will be picked up by next step. Push onto ready[].
        a.state = READY;
        this.ready.push(a);
      } else {
        a.state = READY;
      }
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
      a.state = PARKED;
      a.dispose = dispose;
    }
  }

  private suspendSleep(a: Active, sec: number): void {
    a.state = SLEEPING;
    a.wakeAt = a.clock + sec;
    this.sleepers.push(a);
  }

  private suspendAll(a: Active, children: Yieldable[]): void {
    if (children.length === 0) {
      this.advance(a, undefined);
      return;
    }
    let left = children.length;
    a.state = PARKED; // dispose stays undefined; wake via onChild.
    const onChild = () => {
      if (--left === 0 && a.state === PARKED) {
        a.state = READY;
        this.ready.push(a);
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < children.length; j++) {
      if (a.state === DEAD) return;
      this.spawn(asGen(children[j]), a, onChild);
    }
  }

  private suspendChild(a: Active, gen: Animator<any>): void {
    a.state = PARKED;
    this.spawn(gen, a, () => {
      if (a.state === PARKED) {
        a.state = READY;
        this.ready.push(a);
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
        if (v === undefined) return; // remains READY
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
      if (a.scale !== 1) this.scaledCount--;
      if (!a.parent) this.roots.delete(a);
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
        if (a.scale !== 1) this.scaledCount--;
        if (!a.parent) this.roots.delete(a);
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
