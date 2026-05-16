// v8: v7_lean structural cleanup + v6 model-a error propagation
//     + slim observer hook for tracing.
//
// ─── Yield contract ──────────────────────────────────────────────────────
//
//   undefined        park 1 frame; resume with dt
//   number > 0       sleep N s; resume with frame-dt of waking step
//   number ≤ 0       sync tail-call; resume with 0
//   Animator<R>      spawn child; resume with R
//                    on child error → throw e into parent at yield site
//   Yieldable[]      spawn all in parallel; resume with [R0, R1, …]
//                    on any error → cancel siblings, throw into parent
//   SuspendFn<T>     (wake, anim) => dispose; resume with T
//   PromiseLike<T>   await; resume with T; reject → throw into parent
//
// ─── Termination model ───────────────────────────────────────────────────
//
//   complete  gen returns naturally       observer.complete(id, value)
//   cancel    engine calls gen.return()   observer.cancel(id)         try/finally runs
//   error     gen throws                  observer.error(id, err)     gen.throw() into parent
//
// Cancel and error are DISTINCT mechanisms. Cancel = "stop now, run cleanup";
// error = "propagate up". Confusing them is the most common bug here.
//
// User wants silent error isolation? Wrap: `yield* ignoreErrors(g())`.
// User wants cancel-with-reason? Wrap the disposer.
//
// ─── Observer ────────────────────────────────────────────────────────────
//
// Optional, slim. Set `anim.observer = {…}` to subscribe. Just IDs;
// userland recovers timing, structure, etc. via `tracedAnim()` (below)
// or its own observer.
//
// ─── What changed vs v4 ──────────────────────────────────────────────────
//
//   removed: SuspendFn's `spawn` arg + setup-window guard (~25 LoC)
//   removed: sub-kids tracking inside subscribe              (~15 LoC)
//   added:   PromiseLike yieldable                           (~12 LoC)
//   added:   model-a error propagation                       (~15 LoC)
//   net:     176 → ~190 LoC engine, +Promise sugar, +coherent errors

export type Yieldable<T = any> =
  | undefined | number
  | Animator<T> | Yieldable<T>[]
  | SuspendFn<T> | PromiseLike<T>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  anim: Anim,
) => () => void;

const DEAD = -1, READY = 0, PARKED = Infinity;
const isGen = (v: any): v is Animator<any> => typeof v?.next === "function";
const isThenable = (v: any): v is PromiseLike<any> =>
  v !== null && typeof v === "object" && typeof v.then === "function";
function* asGen(y: Yieldable): Animator<any> { return yield y; }

export interface AnimObserver {
  spawn?(id: number, parentId: number | null, gen: Animator<any>): void;
  complete?(id: number, value: unknown): void;
  cancel?(id: number): void;
  error?(id: number, err: unknown): void;
}

class Active {
  wakeAt = READY;
  cleanup: (() => void) | null = null;
  /** Settlement callback. Called as (value, idx, err) — err undefined on
   *  natural completion, defined on throw. The shared `(v,idx,err)` shape
   *  is used by both spawnOne (idx=0) and spawnKids (idx=slot). */
  onSettle: ((v: any, idx: number, err: unknown) => void) | null = null;
  kidIdx = 0;
  busy = false; pendingReturn = false;
  /** Observer id; 0 means unobserved. */
  obsId = 0;
  constructor(readonly gen: Animator<any>) {}
}

interface Ticker { cb: (dt: number, t: number) => void; t0: number; alive: boolean; }
function safeTick(t: Ticker, dt: number, time: number, onErr: (e: unknown) => void): void {
  try { t.cb(dt, time); } catch (e) { onErr(e); t.alive = false; }
}

export class Anim {
  private as: Active[] = [];
  private ts: Ticker[] = [];
  private dead = 0;
  private nextId = 0;
  observer: AnimObserver | undefined;
  onError: (e: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  run<R>(g: Animator<R> | (() => Animator<R>), onSettle?: (v: R | undefined, err: unknown) => void): () => void {
    const a = this.sp(typeof g === "function" ? g() : g, null,
      onSettle ? (v, _idx, err) => onSettle(err === undefined ? v : undefined, err) : null);
    return () => this.cx(a);
  }

  stop(): void {
    for (const a of this.as) this.cx(a);
    this.as.length = 0; this.ts.length = 0; this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const c = this.clock, ts = this.ts, onErr = this.onError;
    let w = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]; if (!t.alive) continue;
      safeTick(t, dt, c - t.t0, onErr);
      if (t.alive) ts[w++] = t;
    }
    ts.length = w;
    const as = this.as, len = as.length, d0 = this.dead;
    for (let i = 0; i < len; i++) {
      const a = as[i];
      if (a.wakeAt !== DEAD && a.wakeAt <= c) { a.wakeAt = READY; this.adv(a, dt, false); }
    }
    if (this.dead !== d0) {
      let cw = 0;
      for (let i = 0; i < as.length; i++) if (as[i].wakeAt !== DEAD) as[cw++] = as[i];
      as.length = cw;
    }
  }

  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t: Ticker = { cb, t0: this.clock, alive: true };
    this.ts.push(t);
    return () => { t.alive = false; };
  }

  private sp(
    g: Animator<any>, parent: Active | null,
    onSettle: ((v: any, idx: number, err: unknown) => void) | null,
  ): Active {
    const a = new Active(g); a.onSettle = onSettle; this.as.push(a);
    if (this.observer) {
      a.obsId = ++this.nextId;
      try { this.observer.spawn?.(a.obsId, parent?.obsId || null, g); }
      catch (e) { this.onError(e); }
    }
    this.adv(a, undefined, false);
    return a;
  }

  private cx(a: Active): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.dead++;
    if (this.observer) try { this.observer.cancel?.(a.obsId); } catch (e) { this.onError(e); }
    const c = a.cleanup; a.cleanup = null; a.onSettle = null;
    if (c) c();
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch (e) { this.onError(e); }
  }

  private settle(a: Active, value: unknown, errored: boolean, err: unknown): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.dead++;
    if (this.observer) try {
      if (errored) this.observer.error?.(a.obsId, err);
      else this.observer.complete?.(a.obsId, value);
    } catch (e) { this.onError(e); }
    const cb = a.onSettle; a.onSettle = null;
    if (cb) cb(errored ? undefined : value, a.kidIdx, errored ? err : undefined);
    else if (errored) this.onError(err); // unhandled, surfaced at root
  }

  private adv(a: Active, resume: any, asThrow: boolean): void {
    a.busy = true;
    try {
      let r = asThrow ? a.gen.throw(resume) : a.gen.next(resume);
      while (!r.done) {
        if (a.wakeAt === DEAD) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = this.clock + v; return; }
          r = a.gen.next(0); continue;
        }
        if (typeof v === "function") return this.sub(a, v as SuspendFn<any>);
        if (Array.isArray(v)) return this.kids(a, v);
        if (isThenable(v)) return this.then(a, v);
        return this.one(a, v as Animator<any>);
      }
      this.settle(a, r.value, false, undefined);
    } catch (e) {
      this.settle(a, undefined, true, e);
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try { a.gen.return(undefined); } catch (e) { this.onError(e); }
      }
    }
  }

  private sub(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const wake = (val?: any): void => {
      if (resumed || a.wakeAt === DEAD) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = READY;
      if (c) c();
      this.adv(a, val, false);
    };
    const dispose = impl(wake, this);
    if (resumed || a.wakeAt === DEAD) {
      try { dispose(); } catch (e) { this.onError(e); }
    } else {
      a.wakeAt = PARKED;
      a.cleanup = dispose;
    }
  }

  private then(a: Active, p: PromiseLike<any>): void {
    a.wakeAt = PARKED;
    let cancelled = false;
    a.cleanup = () => { cancelled = true; };
    p.then(
      (v) => {
        if (cancelled || a.wakeAt === DEAD) return;
        a.cleanup = null; a.wakeAt = READY;
        this.adv(a, v, false);
      },
      (e) => {
        if (cancelled || a.wakeAt === DEAD) return;
        a.cleanup = null; a.wakeAt = READY;
        this.adv(a, e, true);
      },
    );
  }

  /** Single-child path. On child throw, propagate via gen.throw. */
  private one(a: Active, child: Animator<any>): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== DEAD) this.cx(c); };
    c = this.sp(child, a, (v, _idx, err) => {
      if (a.wakeAt === PARKED && a.cleanup !== null) {
        a.cleanup = null; a.wakeAt = READY;
        if (err !== undefined) this.adv(a, err, true);
        else this.adv(a, v, false);
      }
    });
  }

  /** Parallel-all. On any child error: cancel siblings, throw into parent. */
  private kids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.adv(a, [], false);
    const children: Active[] = [];
    const results: any[] = new Array(kids.length);
    let left = kids.length;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt !== DEAD) this.cx(c);
    };
    const onChild = (v: any, idx: number, err: unknown): void => {
      if (a.cleanup === null || a.wakeAt === DEAD) return;
      if (err !== undefined) {
        const c = a.cleanup; a.cleanup = null;
        a.wakeAt = READY;
        if (c) c();
        this.adv(a, err, true);
        return;
      }
      results[idx] = v;
      if (--left === 0) {
        a.cleanup = null; a.wakeAt = READY;
        this.adv(a, results, false);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt === DEAD) return;
      const k = kids[j];
      const child = this.sp(isGen(k) ? k : asGen(k), a, onChild);
      child.kidIdx = j;
      children.push(child);
    }
  }
}

// ─── Userland combinators ─────────────────────────────────────────────────

/** Per-frame callback; complete by returning false. Returns Animator so
 *  it can be `yield`ed (parks active until done) or `yield*`ed. */
export const driveEffect = (cb: (dt: number, t: number) => boolean | void): SuspendFn<void> =>
  (wake, anim) => anim.onFrame((dt, t) => { if (cb(dt, t) === false) wake(); });

export function* drive(cb: (dt: number, t: number) => boolean | void): Animator<void> {
  yield driveEffect(cb);
}

/** Race over Animators. First to settle wins; siblings cancel. Errors propagate. */
export const race = <T>(gens: Animator<any>[]): SuspendFn<T> => (wake, anim) => {
  let done = false;
  const ds = gens.map((g) => anim.run(g, (v, err) => {
    if (done) return; done = true;
    for (const d of ds) d();
    // Note: errors here surface via anim.onError — race winners are values.
    // Use ignoreErrors() if you want to keep racing past throwers.
    if (err === undefined) wake(v as T);
  }));
  return () => { done = true; for (const d of ds) d(); };
};

/** Sleep+race: returns ok|timeout. */
export function* withTimeout<T>(
  g: Animator<T>, seconds: number,
): Animator<{ kind: "ok"; value: T } | { kind: "timeout" }> {
  return (yield race([
    (function* () { yield seconds; return { kind: "timeout" as const }; })(),
    (function* () { return { kind: "ok" as const, value: yield* g }; })(),
  ])) as { kind: "ok"; value: T } | { kind: "timeout" };
}

/** Wrap to swallow errors; child becomes a value-or-undefined producer. */
export function* ignoreErrors<T>(g: Animator<T>): Animator<T | undefined> {
  try { return yield* g; } catch { return undefined; }
}

/** Subscribe to an external event source; resume on first event. */
export const fromEvent = <T>(
  subscribe: (emit: (v: T) => void) => () => void,
): SuspendFn<T> => (wake) => {
  let live = true;
  const off = subscribe((v) => { if (!live) return; live = false; off(); wake(v); });
  return () => { live = false; off(); };
};

// ─── Tracing: tracedAnim() ────────────────────────────────────────────────

export interface Span {
  id: number;
  parentId: number | null;
  startedAt: number;
  endedAt?: number;
  status: "running" | "complete" | "cancelled" | "error";
  value?: unknown;
  error?: unknown;
  /** Source generator for label resolution; set at spawn. */
  gen: Animator<any>;
}

export type TracedAnim = Anim & {
  spans: Map<number, Span>;
  /** Pretty tree at the current moment. */
  tree(): string;
};

export function tracedAnim(): TracedAnim {
  const a = new Anim();
  const spans = new Map<number, Span>();
  a.observer = {
    spawn(id, parentId, gen) {
      spans.set(id, { id, parentId, startedAt: a.clock, status: "running", gen });
    },
    complete(id, value) {
      const s = spans.get(id); if (!s) return;
      s.status = "complete"; s.endedAt = a.clock; s.value = value;
    },
    cancel(id) {
      const s = spans.get(id); if (!s) return;
      s.status = "cancelled"; s.endedAt = a.clock;
    },
    error(id, err) {
      const s = spans.get(id); if (!s) return;
      s.status = "error"; s.endedAt = a.clock; s.error = err;
    },
  };
  const ta = a as TracedAnim;
  ta.spans = spans;
  ta.tree = (): string => {
    const byParent = new Map<number | null, Span[]>();
    for (const s of spans.values()) {
      const list = byParent.get(s.parentId) ?? [];
      list.push(s);
      byParent.set(s.parentId, list);
    }
    const lines: string[] = [];
    const walk = (parentId: number | null, indent: string): void => {
      const kids = byParent.get(parentId) ?? [];
      for (const s of kids) {
        const dur = s.endedAt !== undefined ? `${(s.endedAt - s.startedAt).toFixed(3)}s` : "running";
        const name = (s.gen as any)?.constructor?.name === "Generator"
          ? ((s.gen as any).toString?.().slice(0, 30) ?? "<gen>")
          : "<gen>";
        lines.push(`${indent}#${s.id} ${s.status} ${dur} ${name}`);
        walk(s.id, indent + "  ");
      }
    };
    walk(null, "");
    return lines.join("\n");
  };
  return ta;
}
