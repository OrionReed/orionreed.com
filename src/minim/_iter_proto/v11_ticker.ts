// v11_ticker: v9_lean + Ticker fast path restored + drive moves userland.
//
// Same yield contract & termination model as v8/v9. The two fast paths:
//
//   • Sleep (`yield N`)  → wakeAt sentinel; step skips until clock crosses.
//                          Zero gen.next per frame for sleeping actives.
//   • Ticker (`onStep`)  → registered listeners fire each step, no advance.
//                          Used by `drive(cb)` (userland) for per-frame work
//                          without paying gen.next per frame.
//
// Compared to v8:
//   • Drops engine observer hook (use TracedAnim subclass instead).
//   • Drops SuspendFn's `spawn` arg + setup-window guard.
//   • Drops `yield ≤ 0` from public contract (still works internally as
//     1-frame park to avoid surprising ≤0 yields).
//   • Drops `asGen` for non-gen array elements.
//
// Methods: start / stop / step / onStep.

export type Yieldable<T = any> =
  | undefined | number
  | Animator<T> | Yieldable<T>[]
  | SuspendFn<T> | PromiseLike<T>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type SuspendFn<T = void> = (wake: (v: T) => void, anim: Anim) => () => void;

const isGen = (v: any): v is Animator<any> => typeof v?.next === "function";
const isThenable = (v: any): v is PromiseLike<any> =>
  v !== null && typeof v === "object" && typeof v.then === "function";

class Active {
  /** −1 dead, 0 ready, >0 sleep, Infinity parked. */
  wakeAt = 0;
  cleanup: (() => void) | null = null;
  onSettle: ((v: any, idx: number, err: unknown) => void) | null = null;
  kidIdx = 0;
  busy = false; pendingReturn = false;
  constructor(readonly gen: Animator<any>) {}
}

interface Listener { cb: (dt: number, t: number) => void; t0: number; alive: boolean; }
function safeTick(l: Listener, dt: number, t: number, onErr: (e: unknown) => void): void {
  try { l.cb(dt, t); } catch (e) { onErr(e); l.alive = false; }
}

export class Anim {
  protected actives: Active[] = [];
  private listeners: Listener[] = [];
  private dead = 0;
  onError: (e: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  start<R>(g: Animator<R> | (() => Animator<R>), onSettle?: (v: R | undefined, err: unknown) => void): () => void {
    const a = this.spawn(typeof g === "function" ? g() : g,
      onSettle ? (v, _i, err) => onSettle(err === undefined ? v : undefined, err) : null);
    return () => this.cancel(a);
  }

  stop(): void {
    for (const a of this.actives) this.cancel(a);
    this.actives.length = 0; this.listeners.length = 0; this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const c = this.clock, ls = this.listeners, onErr = this.onError;

    let lw = 0;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]; if (!l.alive) continue;
      safeTick(l, dt, c - l.t0, onErr);
      if (l.alive) ls[lw++] = l;
    }
    ls.length = lw;

    const as = this.actives, len = as.length, d0 = this.dead;
    for (let i = 0; i < len; i++) {
      const a = as[i];
      if (a.wakeAt !== -1 && a.wakeAt <= c) { a.wakeAt = 0; this.advance(a, dt, false); }
    }
    if (this.dead !== d0) {
      let w = 0;
      for (let i = 0; i < as.length; i++) if (as[i].wakeAt !== -1) as[w++] = as[i];
      as.length = w;
    }
  }

  /** Subscribe to per-step ticks. Public ticker hook; off when cb returns
   *  false isn't supported here (use the closure-self-disposes pattern). */
  onStep(cb: (dt: number, t: number) => void): () => void {
    const l: Listener = { cb, t0: this.clock, alive: true };
    this.listeners.push(l);
    return () => { l.alive = false; };
  }

  protected spawn(g: Animator<any>, onSettle: ((v: any, i: number, err: unknown) => void) | null): Active {
    const a = new Active(g); a.onSettle = onSettle; this.actives.push(a);
    this.advance(a, undefined, false);
    return a;
  }

  protected cancel(a: Active): void {
    if (a.wakeAt === -1) return;
    a.wakeAt = -1; this.dead++;
    const c = a.cleanup; a.cleanup = null; a.onSettle = null;
    if (c) c();
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch (e) { this.onError(e); }
  }

  protected settle(a: Active, value: unknown, errored: boolean, err: unknown): void {
    if (a.wakeAt === -1) return;
    a.wakeAt = -1; this.dead++;
    const cb = a.onSettle; a.onSettle = null;
    if (cb) cb(errored ? undefined : value, a.kidIdx, errored ? err : undefined);
    else if (errored) this.onError(err);
  }

  private advance(a: Active, resume: any, asThrow: boolean): void {
    a.busy = true;
    try {
      let r = asThrow ? a.gen.throw(resume) : a.gen.next(resume);
      while (!r.done) {
        if (a.wakeAt === -1) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = this.clock + v; return; }
          return; // ≤ 0 internal: park 1 frame
        }
        if (typeof v === "function") return this.suspend(a, v as SuspendFn<any>);
        if (Array.isArray(v)) return this.parallel(a, v);
        if (isThenable(v)) return this.thenable(a, v);
        return this.child(a, v as Animator<any>);
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
      if (resumed || a.wakeAt === -1) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = 0;
      if (c) c();
      this.advance(a, val, false);
    };
    const dispose = impl(wake, this);
    if (resumed || a.wakeAt === -1) try { dispose(); } catch (e) { this.onError(e); }
    else { a.wakeAt = Infinity; a.cleanup = dispose; }
  }

  private thenable(a: Active, p: PromiseLike<any>): void {
    a.wakeAt = Infinity;
    let cancelled = false;
    a.cleanup = () => { cancelled = true; };
    p.then(
      (v) => { if (!cancelled && a.wakeAt !== -1) { a.cleanup = null; a.wakeAt = 0; this.advance(a, v, false); } },
      (e) => { if (!cancelled && a.wakeAt !== -1) { a.cleanup = null; a.wakeAt = 0; this.advance(a, e, true); } },
    );
  }

  private child(a: Active, child: Animator<any>): void {
    a.wakeAt = Infinity;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== -1) this.cancel(c); };
    c = this.spawn(child, (v, _i, err) => {
      if (a.wakeAt === Infinity && a.cleanup !== null) {
        a.cleanup = null; a.wakeAt = 0;
        this.advance(a, err === undefined ? v : err, err !== undefined);
      }
    });
  }

  private parallel(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, [], false);
    const children: Active[] = [];
    const results: any[] = new Array(kids.length);
    let left = kids.length;
    a.wakeAt = Infinity;
    a.cleanup = () => { for (const c of children) if (c.wakeAt !== -1) this.cancel(c); };
    const onChild = (v: any, idx: number, err: unknown): void => {
      if (a.cleanup === null || a.wakeAt === -1) return;
      if (err !== undefined) {
        const c = a.cleanup; a.cleanup = null;
        a.wakeAt = 0; if (c) c();
        this.advance(a, err, true); return;
      }
      results[idx] = v;
      if (--left === 0) { a.cleanup = null; a.wakeAt = 0; this.advance(a, results, false); }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt === -1) return;
      const k = kids[j];
      if (!isGen(k)) throw new Error("v11: parallel array elements must be Animators");
      const child = this.spawn(k, onChild);
      child.kidIdx = j;
      children.push(child);
    }
  }
}

// ─── userland combinators ─────────────────────────────────────────────────

/** Effect form: register a per-frame callback; complete on returning false. */
export const driveEffect = (cb: (dt: number, t: number) => boolean | void): SuspendFn<void> =>
  (wake, anim) => anim.onStep((dt, t) => { if (cb(dt, t) === false) wake(); });

export function* drive(cb: (dt: number, t: number) => boolean | void): Animator<void> {
  yield driveEffect(cb);
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
