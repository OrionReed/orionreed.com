// v7 — Bucketed scheduler. The big idea: stop walking PARKED actives.
//
// In v6 the per-step loop iterates `active[]` once per frame and skips
// non-READY entries via a state branch. That branch is fast but it's
// still O(N) where N includes every parked subscription. v7 keeps each
// active in exactly one bucket:
//
//   • `ticking[]`   — READY actives. Walked every frame.
//   • `sleeping`    — binary min-heap by wakeAtAnim. O(1) `peek`,
//                     O(log K) push/pop. Cancelled sleepers are
//                     tombstoned (state=DEAD); pop drops them.
//   • PARKED        — not in any list. Held alive by closures (wake)
//                     and `parent.children`. Top-level PARKED roots
//                     additionally tracked in `parkedRoots[]` so that
//                     `stop()` can find and cancel them.
//
// Side effects of the heap:
//   • `nextDueIn()` is exposed for headless drivers / tests:
//     `0` if anything is ready right now, else the heap's earliest
//     `wakeAtAnim - clock`, else `Infinity` (engine is idle).
//
// The v6 ticker primitive is kept verbatim — `drive(step)` still
// bypasses generators entirely. Tickers are a separate per-frame
// callback registry; orthogonal to the bucketed actives.
//
// `Active.wake` is a method allocated once at construction (G5),
// re-armed by setting `a.resumed = false` at subscribe-time. Saves one
// closure per `suspend`.
//
// Trade-off: sleep heap stores `wakeAtAnim = animClock + sec/effScale`
// computed at sleep-yield time. Reactive scale changes during sleep
// don't shorten/extend it. Static scale (the common case) is exact.
// `engine-current` re-evaluates each frame, so this is a documented
// micro-regression on a rare path.

const FRAME_CAP_MS = 32;

export interface RuntimeAccess {
  /** Per-frame callback. Inside a SuspendFn, the host's effective
   *  scale and lifecycle apply. */
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
const PARKED = 2;
const DEAD = 3;

class Active {
  state: number = READY;
  // Bucket positions; -1 means "not in this bucket".
  tickIdx: number = -1;
  sleepIdx: number = -1;
  rootIdx: number = -1;
  // Sleep targets. `wakeAt` is in own-clock (restores `clock` on wake
  // so the next `yield N` is anchored correctly). `wakeAtAnim` is the
  // heap key.
  wakeAt: number = 0;
  wakeAtAnim: number = 0;
  // Defined iff PARKED via SuspendFn (vs PARKED waiting on children).
  dispose: (() => void) | undefined = undefined;
  onComplete: ((value: unknown) => void) | undefined = undefined;
  observeId: number = 0;
  scale: number | (() => number) = 1;
  effScale: number = 1;
  // Own-clock; only ticked while READY (or sampled at sleep-start).
  clock: number = 0;
  children: Active[] | undefined = undefined;
  siblingIdx: number = -1;
  // Per-suspend: false at subscribe-start, true after first wake.
  resumed: boolean = false;
  // Pre-allocated wake closure — shared across all this active's
  // suspensions; resumed flag gates idempotency. (G5)
  readonly wake: (v?: unknown) => void;

  constructor(
    readonly engine: Anim,
    readonly gen: Animator<any>,
    readonly parent: Active | undefined,
  ) {
    const self = this;
    this.wake = (value?: unknown): void => {
      if (self.resumed || self.state === DEAD) return;
      self.resumed = true;
      const d = self.dispose;
      self.dispose = undefined;
      self.state = READY;
      // PARKED → READY: detach from parkedRoots if top-level.
      if (self.rootIdx >= 0) self.engine.detachRoot(self);
      if (d) d();
      self.engine.advanceAndRoute(self, value);
    };
  }
}

// One per-frame callback registration (drive-style). Same as v6.
class Ticker {
  alive = true;
  t = 0;
  constructor(
    readonly host: Active | undefined,
    readonly cb: (dt: number, t: number) => void,
  ) {}
}

// ── Binary min-heap of Actives keyed by wakeAtAnim ───────────────────

class SleepHeap {
  private a: Active[] = [];
  get size(): number { return this.a.length; }
  peekKey(): number {
    return this.a.length === 0 ? Infinity : this.a[0].wakeAtAnim;
  }
  push(x: Active): void {
    const a = this.a;
    let i = a.length;
    a.push(x);
    x.sleepIdx = i;
    // Sift up.
    const k = x.wakeAtAnim;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const par = a[p];
      if (par.wakeAtAnim <= k) break;
      a[i] = par; par.sleepIdx = i;
      i = p;
    }
    a[i] = x; x.sleepIdx = i;
  }
  pop(): Active | undefined {
    const a = this.a;
    const n = a.length;
    if (n === 0) return undefined;
    const top = a[0];
    top.sleepIdx = -1;
    if (n === 1) { a.length = 0; return top; }
    const last = a.pop()!;
    a[0] = last; last.sleepIdx = 0;
    // Sift down.
    let i = 0;
    const k = last.wakeAtAnim;
    const m = a.length;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      let sk = k;
      if (l < m && a[l].wakeAtAnim < sk) { s = l; sk = a[l].wakeAtAnim; }
      if (r < m && a[r].wakeAtAnim < sk) { s = r; sk = a[r].wakeAtAnim; }
      if (s === i) break;
      const sw = a[s];
      a[i] = sw; sw.sleepIdx = i;
      i = s;
    }
    a[i] = last; last.sleepIdx = i;
    return top;
  }
  clear(): void {
    for (const x of this.a) x.sleepIdx = -1;
    this.a.length = 0;
  }
  // Iterate live entries (for stop()).
  forEach(cb: (a: Active) => void): void {
    for (const x of this.a) cb(x);
  }
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
  // Buckets.
  private ticking: Active[] = [];
  private sleeping = new SleepHeap();
  // PARKED top-level roots; non-roots are reachable via parent.children.
  private parkedRoots: Active[] = [];
  // Drive-style callbacks (v6 ticker primitive).
  private tickers: Ticker[] = [];

  private rafId = 0;
  private _clockMs = 0;
  private lastFrame = 0;
  private clockListeners: Array<(t: number) => void> | undefined;
  private nextActiveId = 0;
  // Re-entrancy queue for cancel inside advance().
  private pendingReturns: Array<Animator<any>> | undefined;
  private inAdvance = 0;
  // Set during a SuspendFn impl; new tickers inherit this as their host.
  private subscribingHost: Active | undefined = undefined;
  // Single hasScale gate (v6). Never reset; cost of leaving true is
  // one branch per frame and negligible.
  private hasScale = false;

  observer: AnimObserver | undefined = undefined;

  // ── Public API ──────────────────────────────────────────────────────

  get clockMs(): number { return this._clockMs; }

  /** How long until the engine has work to do (in seconds). 0 if
   *  anything is currently ticking; Infinity if fully idle. Useful for
   *  headless drivers that want to sleep precisely. */
  nextDueIn(): number {
    if (this.ticking.length > 0 || this.tickers.length > 0) return 0;
    const k = this.sleeping.peekKey();
    if (k === Infinity) return Infinity;
    return Math.max(0, k - this._clockMs);
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
    // Snapshot then cancel — cancel mutates buckets (including
    // detaching from parkedRoots), so don't pre-clear; let cascade
    // unwind cleanly.
    const snap: Active[] = [];
    for (const a of this.ticking) if (a.state !== DEAD) snap.push(a);
    this.sleeping.forEach((a) => { if (a.state !== DEAD) snap.push(a); });
    for (const a of this.parkedRoots) if (a.state !== DEAD) snap.push(a);
    for (const a of snap) this.cancel(a);
    this.ticking.length = 0;
    this.parkedRoots.length = 0;
    this.sleeping.clear();
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

    // 1. Pop expired sleepers and advance them.
    const now = this._clockMs;
    const sl = this.sleeping;
    while (sl.size > 0 && sl.peekKey() <= now) {
      const a = sl.pop()!;
      if (a.state !== SLEEPING) continue; // tombstoned by cancel
      a.state = READY;
      // Restore own-clock to the target so the next `yield N` is
      // anchored at the right point.
      a.clock = a.wakeAt;
      this.advanceAndRoute(a, undefined);
    }

    // 2. Tick the READY actives.
    const tk = this.ticking;
    if (tk.length > 0) {
      let w = 0;
      const useScale = this.hasScale;
      for (let i = 0; i < tk.length; i++) {
        const a = tk[i];
        if (a.state !== READY) {
          a.tickIdx = -1;
          continue;
        }
        let scaled: number;
        if (useScale) {
          const s = a.scale;
          const own = typeof s === "number" ? s : s();
          a.effScale = (a.parent ? a.parent.effScale : 1) * own;
          scaled = dt * a.effScale;
        } else {
          scaled = dt;
        }
        a.clock += scaled;
        this.advance(a, scaled);
        if (a.state === READY) {
          if (i !== w) { tk[w] = a; a.tickIdx = w; }
          w++;
        } else {
          a.tickIdx = -1;
          // Route the (possibly) new bucket. SLEEPING / PARKED / DEAD
          // were set up by suspendSleep / subscribe / suspendOnChildren
          // / completion. Nothing more to do here.
        }
      }
      tk.length = w;
    }

    // 3. Tick the drive-style callbacks (v6 ticker primitive).
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

  // ── Internal: bucket plumbing ───────────────────────────────────────

  detachRoot(a: Active): void {
    const i = a.rootIdx;
    if (i < 0) return;
    const arr = this.parkedRoots;
    const last = arr.length - 1;
    if (i !== last) {
      const moved = arr[last];
      arr[i] = moved;
      moved.rootIdx = i;
    }
    arr.length = last;
    a.rootIdx = -1;
  }

  private addTicking(a: Active): void {
    if (a.tickIdx >= 0) return;
    a.tickIdx = this.ticking.length;
    this.ticking.push(a);
  }

  /** Called by spawn() and Active.wake. Runs `advance(a, resume)` and
   *  routes `a` to its bucket based on the resulting state. */
  advanceAndRoute(a: Active, resume: unknown): void {
    this.advance(a, resume);
    const st = a.state;
    if (st === READY) this.addTicking(a);
    else if (st === PARKED) {
      if (!a.parent && a.rootIdx < 0) {
        a.rootIdx = this.parkedRoots.length;
        this.parkedRoots.push(a);
      }
    }
    // SLEEPING: pushed to heap by suspendSleep.
    // DEAD: nothing.
  }

  // ── spawn / cancel ──────────────────────────────────────────────────

  private spawn(
    gen: Animator<any>,
    parent?: Active,
    onComplete?: (value: unknown) => void,
    scale?: number | (() => number),
  ): Active {
    const a = new Active(this, gen, parent);
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
    if (this.observer?.spawn) {
      a.observeId = ++this.nextActiveId;
      this.observer.spawn(
        a.observeId,
        parent && parent.observeId !== 0 ? parent.observeId : undefined,
        this._clockMs,
        gen,
      );
    }
    this.advanceAndRoute(a, undefined);
    this.kick();
    return a;
  }

  private cancel(a: Active): void {
    if (a.state === DEAD) return;
    const wasParked = a.state === PARKED;
    a.state = DEAD;
    if (this.observer?.cancel && a.observeId !== 0) {
      this.observer.cancel(a.observeId, this._clockMs);
    }
    if (wasParked) {
      const d = a.dispose;
      a.dispose = undefined;
      if (d) d();
    }
    // Detach from buckets (sleep tombstones; ticking gets compacted on
    // its own; root needs explicit detach).
    if (a.rootIdx >= 0) this.detachRoot(a);
    // Detach from parent.children.
    this.detach(a);
    // Cascade.
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

  // ── RAF plumbing ────────────────────────────────────────────────────

  private kick(): void {
    if (this.rafId !== 0) return;
    if (
      this.ticking.length === 0 &&
      this.sleeping.size === 0 &&
      this.tickers.length === 0
    ) return;
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

  // ── Suspension paths ────────────────────────────────────────────────

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    a.resumed = false;
    let setupActive = true;
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
      dispose = impl(a.wake, spawn, this);
    } finally {
      this.subscribingHost = prevHost;
    }
    setupActive = false;
    if (a.resumed || a.state === DEAD) {
      dispose();
    } else {
      a.state = PARKED;
      a.dispose = dispose;
      // Routing to parkedRoots happens in advanceAndRoute().
    }
  }

  private suspendSleep(a: Active, sec: number): void {
    a.state = SLEEPING;
    a.wakeAt = a.clock + sec;
    const eff = this.hasScale ? a.effScale : 1;
    a.wakeAtAnim = this._clockMs + sec / eff;
    this.sleeping.push(a);
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
        if (a.rootIdx >= 0) this.detachRoot(a);
        this.advanceAndRoute(a, undefined);
      }
    };
    for (let j = 0; j < children.length; j++) {
      if (a.state === DEAD) return;
      this.spawn(asGen(children[j]), a, onChild);
    }
  }

  // ── Generator advance ───────────────────────────────────────────────

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
          this.suspendOnChildren(a, v);
          return;
        }
        this.suspendOnChildren(a, [v as Animator<any>]);
        return;
      }
      // Natural completion.
      if (a.state === DEAD) return;
      a.state = DEAD;
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
        this.detach(a);
      }
    } finally {
      this.inAdvance--;
      if (this.inAdvance === 0) this.drainPendingReturns();
    }
  }
}

// ── drive() — uses the runtime ticker fast path ─────────────────────

export function drive(
  step: (dt: number, t: number) => boolean | void,
): Animator {
  return suspend<void>((wake, _spawn, anim) => {
    return anim.onFrame((dt, t) => {
      if (step(dt, t) === false) wake();
    });
  });
}
