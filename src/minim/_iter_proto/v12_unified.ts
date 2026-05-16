// v12_unified: same contract as v11, but with the engine's parking
// machinery unified into ONE primitive (`park`). The four park-and-resume
// flavours (suspend / array / animator / promise) all reduce to the same
// shape:
//
//   park(active, install: (resume) => dispose)
//
// Where `resume(value, err?)` is the unified resume function. Every
// yieldable type becomes a 4-line install closure that handles its own
// child-management and ultimately calls `resume(value)` or `resume(undefined, err)`.
//
// Conceptual model:
//   • Engine recognises two fast paths: `undefined` (1-frame park) and
//     `number > 0` (sleep). These pay zero allocation per yield.
//   • Everything else IS a SuspendFn — user-supplied directly, or built
//     from the library shapes (Animator / array / Promise) via internal
//     install closures. The engine doesn't have separate machinery for
//     each — they all flow through `park`.
//
// Same yield contract as v11. Same termination model. Same perf target.
// LoC target: ~150 (vs v11's 164).

export type Yieldable<T = any> =
  | undefined | number
  | Animator<T> | Yieldable<T>[]
  | SuspendFn<T> | PromiseLike<T>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type SuspendFn<T = void> = (wake: (v: T) => void, anim: Anim) => () => void;
type Resume = (value: any, err?: unknown) => void;

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

  /** The single park primitive. `install` is invoked synchronously with
   *  a `resume(v, err?)` callback; it must return a dispose function for
   *  the parent's cancel cascade. If install calls `resume` synchronously,
   *  the dispose is invoked immediately (single-fire). */
  private park(a: Active, install: (resume: Resume) => () => void): void {
    let resumed = false;
    const resume: Resume = (value, err) => {
      if (resumed || a.wakeAt === -1) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = 0;
      if (c) c();
      this.advance(a, err === undefined ? value : err, err !== undefined);
    };
    const dispose = install(resume);
    if (resumed || a.wakeAt === -1) try { dispose(); } catch (e) { this.onError(e); }
    else { a.wakeAt = Infinity; a.cleanup = dispose; }
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
          return;
        }
        if (typeof v === "function") {
          return this.park(a, (re) => (v as SuspendFn<any>)(re as any, this));
        }
        if (Array.isArray(v)) return this.park(a, (re) => this.installParallel(v, re));
        if (isThenable(v)) return this.park(a, (re) => this.installPromise(v, re));
        return this.park(a, (re) => this.installChild(v as Animator, re));
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

  private installPromise(p: PromiseLike<any>, resume: Resume): () => void {
    let cancelled = false;
    p.then(
      (v) => { if (!cancelled) resume(v); },
      (e) => { if (!cancelled) resume(undefined, e); },
    );
    return () => { cancelled = true; };
  }

  private installChild(child: Animator<any>, resume: Resume): () => void {
    const c = this.spawn(child, (v, _i, err) => resume(v, err));
    return () => { if (c.wakeAt !== -1) this.cancel(c); };
  }

  private installParallel(kids: Yieldable[], resume: Resume): () => void {
    if (kids.length === 0) { resume([]); return () => {}; }
    const children: Active[] = [];
    const results: any[] = new Array(kids.length);
    let left = kids.length, settled = false;
    const onChild = (v: any, idx: number, err: unknown): void => {
      if (settled) return;
      if (err !== undefined) { settled = true; resume(undefined, err); return; }
      results[idx] = v;
      if (--left === 0) { settled = true; resume(results); }
    };
    for (let j = 0; j < kids.length; j++) {
      const k = kids[j];
      if (!isGen(k)) throw new Error("v12: parallel array elements must be Animators");
      const child = this.spawn(k, onChild);
      child.kidIdx = j;
      children.push(child);
    }
    return () => { for (const c of children) if (c.wakeAt !== -1) this.cancel(c); };
  }
}

// ─── userland combinators ─────────────────────────────────────────────────

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
