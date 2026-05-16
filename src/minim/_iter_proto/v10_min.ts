// v10_min: target ~100 LoC engine. Lean further by making sleep userland.
//
// Drops vs v9:
//   • `yield N` engine sleep. Becomes `yield* sleep(N)` in userland — a
//     loop that accumulates `dt` until the threshold. Engine drops the
//     wakeAt sentinel encoding entirely; actives are just alive/dead with
//     a "park 1 frame" bit.
//   • Methods get the agreed names: start, stop, step, onStep.
//
// What stays: model-a errors, Promise sugar, parallel arrays, all yield
// shapes except number. tracedAnim.
//
// Yield contract:
//   undefined        park 1 frame; resume with dt
//   Animator<R>      spawn child; resume with R; throw → parent
//   Yieldable[]      parallel; resume with [R…]; first throw cancels rest
//   SuspendFn<T>     (wake, anim) => dispose; resume with T
//   PromiseLike<T>   await; resume with T; reject → throw
//
// Cost of dropping engine sleep: each sleeping active does one gen.next
// per frame instead of 0. At N=1000 sleepers = ~10µs/frame extra. At
// N=100 = ~1µs/frame. Invisible alongside DOM work.

export type Yieldable<T = any> =
  | undefined
  | Animator<T> | Yieldable<T>[]
  | SuspendFn<T> | PromiseLike<T>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type SuspendFn<T = void> = (wake: (v: T) => void, anim: Anim) => () => void;

const isGen = (v: any): v is Animator<any> => typeof v?.next === "function";
const isThenable = (v: any): v is PromiseLike<any> =>
  v !== null && typeof v === "object" && typeof v.then === "function";

class Active {
  dead = false;
  parked = true;  // parked = "do not advance during step"; cleared on `yield;`
  cleanup: (() => void) | null = null;
  onSettle: ((v: any, idx: number, err: unknown) => void) | null = null;
  kidIdx = 0;
  busy = false; pendingReturn = false;
  constructor(readonly gen: Animator<any>) {}
}

export class Anim {
  protected actives: Active[] = [];
  private deads = 0;
  onError: (e: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  start<R>(g: Animator<R> | (() => Animator<R>), onSettle?: (v: R | undefined, err: unknown) => void): () => void {
    const a = this.spawn(typeof g === "function" ? g() : g,
      onSettle ? (v, _i, err) => onSettle(err === undefined ? v : undefined, err) : null);
    return () => this.cancel(a);
  }

  stop(): void {
    for (const a of this.actives) this.cancel(a);
    this.actives.length = 0; this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const as = this.actives, len = as.length, d0 = this.deads;
    for (let i = 0; i < len; i++) {
      const a = as[i];
      if (!a.dead && !a.parked) { a.parked = true; this.advance(a, dt, false); }
    }
    if (this.deads !== d0) {
      let w = 0;
      for (let i = 0; i < as.length; i++) if (!as[i].dead) as[w++] = as[i];
      as.length = w;
    }
  }

  onStep(cb: (dt: number, t: number) => void): () => void {
    return this.start(function* () {
      let t = 0;
      while (true) { const dt = (yield) as number; t += dt; cb(dt, t); }
    });
  }

  protected spawn(g: Animator<any>, onSettle: ((v: any, i: number, err: unknown) => void) | null): Active {
    const a = new Active(g); a.onSettle = onSettle; this.actives.push(a);
    this.advance(a, undefined, false);
    return a;
  }

  protected cancel(a: Active): void {
    if (a.dead) return;
    a.dead = true; this.deads++;
    const c = a.cleanup; a.cleanup = null; a.onSettle = null;
    if (c) c();
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch (e) { this.onError(e); }
  }

  protected settle(a: Active, value: unknown, errored: boolean, err: unknown): void {
    if (a.dead) return;
    a.dead = true; this.deads++;
    const cb = a.onSettle; a.onSettle = null;
    if (cb) cb(errored ? undefined : value, a.kidIdx, errored ? err : undefined);
    else if (errored) this.onError(err);
  }

  private advance(a: Active, resume: any, asThrow: boolean): void {
    a.busy = true;
    try {
      let r = asThrow ? a.gen.throw(resume) : a.gen.next(resume);
      while (!r.done) {
        if (a.dead) return;
        const v = r.value;
        if (v === undefined) { a.parked = false; return; }
        if (typeof v === "function") return this.suspend(a, v as SuspendFn<any>);
        if (Array.isArray(v)) return this.parallel(a, v);
        if (isThenable(v)) return this.thenable(a, v);
        if (isGen(v)) return this.child(a, v);
        throw new TypeError(`v10: unsupported yield ${typeof v}`);
      }
      this.settle(a, r.value, false, undefined);
    } catch (e) { this.settle(a, undefined, true, e); }
    finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try { a.gen.return(undefined); } catch (e) { this.onError(e); }
      }
    }
  }

  private suspend(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const wake = (val?: any): void => {
      if (resumed || a.dead) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      if (c) c();
      this.advance(a, val, false);
    };
    const dispose = impl(wake, this);
    if (resumed || a.dead) try { dispose(); } catch (e) { this.onError(e); }
    else a.cleanup = dispose;
  }

  private thenable(a: Active, p: PromiseLike<any>): void {
    let cancelled = false;
    a.cleanup = () => { cancelled = true; };
    p.then(
      (v) => { if (!cancelled && !a.dead) { a.cleanup = null; this.advance(a, v, false); } },
      (e) => { if (!cancelled && !a.dead) { a.cleanup = null; this.advance(a, e, true); } },
    );
  }

  private child(a: Active, child: Animator<any>): void {
    let c: Active | null = null;
    a.cleanup = () => { if (c && !c.dead) this.cancel(c); };
    c = this.spawn(child, (v, _i, err) => {
      if (a.cleanup !== null && !a.dead) {
        a.cleanup = null;
        this.advance(a, err === undefined ? v : err, err !== undefined);
      }
    });
  }

  private parallel(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, [], false);
    const children: Active[] = [];
    const results: any[] = new Array(kids.length);
    let left = kids.length;
    a.cleanup = () => { for (const c of children) if (!c.dead) this.cancel(c); };
    const onChild = (v: any, idx: number, err: unknown): void => {
      if (a.cleanup === null || a.dead) return;
      if (err !== undefined) {
        const c = a.cleanup; a.cleanup = null;
        if (c) c();
        this.advance(a, err, true); return;
      }
      results[idx] = v;
      if (--left === 0) { a.cleanup = null; this.advance(a, results, false); }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.dead) return;
      const k = kids[j];
      if (!isGen(k)) throw new Error("v10: parallel array elements must be Animators");
      const child = this.spawn(k, onChild);
      child.kidIdx = j;
      children.push(child);
    }
  }
}

// ─── userland: sleep, drive, ignoreErrors, fromEvent ──────────────────────

/** Sleep N seconds by accumulating dt across frames. */
export function* sleep(s: number): Animator<void> {
  let acc = 0;
  while (acc < s) acc += (yield) as number;
}

/** drive = per-frame callback; complete on returning false. */
export function* drive(cb: (dt: number, t: number) => boolean | void): Animator<void> {
  let t = 0;
  while (true) {
    const dt = (yield) as number;
    t += dt;
    if (cb(dt, t) === false) return;
  }
}

export function* ignoreErrors<T>(g: Animator<T>): Animator<T | undefined> {
  try { return yield* g; } catch { return undefined; }
}

export const fromEvent = <T>(
  subscribe: (emit: (v: T) => void) => () => void,
): SuspendFn<T> => (wake) => {
  let live = true;
  const off = subscribe((v) => { if (!live) return; live = false; off(); wake(v); });
  return () => { live = false; off(); };
};

// ─── tracing as subclass ──────────────────────────────────────────────────

export interface Span {
  id: number; parentId: number | null;
  startedAt: number; endedAt?: number;
  status: "running" | "complete" | "cancelled" | "error";
  value?: unknown; error?: unknown;
}

export class TracedAnim extends Anim {
  spans = new Map<number, Span>();
  private nextId = 0;
  private spanOf = new WeakMap<Active, number>();
  private currentParent: number | undefined;

  protected spawn(g: Animator<any>, onSettle: ((v: any, i: number, err: unknown) => void) | null): Active {
    const id = ++this.nextId;
    this.spans.set(id, { id, parentId: this.currentParent ?? null, startedAt: this.clock, status: "running" });
    const wrapped: typeof onSettle = (v, i, err) => {
      const s = this.spans.get(id)!;
      s.endedAt = this.clock;
      s.status = err !== undefined ? "error" : "complete";
      if (err !== undefined) s.error = err; else s.value = v;
      onSettle?.(v, i, err);
    };
    const prev = this.currentParent;
    this.currentParent = id;
    try {
      const a = super.spawn(g, wrapped);
      this.spanOf.set(a, id);
      return a;
    } finally { this.currentParent = prev; }
  }

  protected cancel(a: Active): void {
    const id = this.spanOf.get(a);
    if (id !== undefined) {
      const s = this.spans.get(id);
      if (s && s.status === "running") { s.status = "cancelled"; s.endedAt = this.clock; }
    }
    super.cancel(a);
  }
}
