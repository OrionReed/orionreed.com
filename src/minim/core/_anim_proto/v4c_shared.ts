// v4c: v4 with spawnKids closure-sharing via an index field on Active.
//      One closure per parallel-wait call instead of N. Active gains
//      a single number field; settle() writes the result inline.
//
// One protocol-level change vs v2:
//
//   * `yield child` resumes the parent with the child's RETURN VALUE
//     (was `undefined` in v0-v3). This closes the long-standing gap
//     with `yield*`, which already returns the value via JS-native
//     delegation.
//
//   * `yield [a, b]` resumes the parent with `[Ra, Rb]` (was
//     `undefined`). `yield []` resumes with `[]`.
//
// Why: without this, the runtime is silently dropping information the
// caller needs and forcing them to either use `yield*` (no engine
// tracking) or go through `all()` / suspend+spawn (allocation-heavy).
// With the fix, `yield child` and `yield*` produce the same value;
// the difference is purely "is this an engine-tracked active". For
// error semantics, errored children resume parent with `undefined`
// (same as v2 — model-b).
//
// Everything else identical to v2.

export type Yieldable =
  | number | undefined | Animator<any> | Yieldable[] | SuspendFn<any>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type PayloadOf<Y> =
  Y extends Animator<infer R> ? R
  : Y extends SuspendFn<infer R> ? R
  : void;
export type SpawnFn = <R>(g: Animator<R>, onDone?: (v: R) => void) => () => void;
export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
  anim: Anim,
) => () => void;

const DEAD = -1, READY = 0, PARKED = Infinity;

export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

export const isGen = (v: any): v is Animator<any> =>
  typeof v?.next === "function";

function* asGen(y: Yieldable): Animator<any> { yield y; }

export interface AnimObserver {
  spawn?(id: number, parentId: number | undefined, clock: number, gen: Animator<any>): void;
  complete?(id: number, clock: number, value?: unknown): void;
  cancel?(id: number, clock: number): void;
  error?(id: number, clock: number, err: unknown): void;
}

class Active {
  wakeAt = READY;
  cleanup: (() => void) | null = null;
  onDone: ((v: any, idx: number) => void) | null = null;
  /** Set when this active is one of a parallel-wait sibling group; the
   *  index identifies the slot in the parent's `results` array. */
  kidIdx = 0;
  busy = false; pendingReturn = false; observeId = 0;
  constructor(readonly gen: Animator<any>) {}
}

class Ticker {
  alive = true; t0 = 0;
  constructor(readonly cb: (dt: number, t: number) => void) {}
}

function safeTick(t: Ticker, dt: number, time: number, onErr: (e: unknown) => void): void {
  try { t.cb(dt, time); } catch (e) { onErr(e); t.alive = false; }
}

export class Anim {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  private deadSeen = 0;
  private nextObserveId = 0;
  observer: AnimObserver | undefined;
  onError: (err: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  run(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof g === "function" ? g() : g, null);
    return () => this.cancel(a);
  }

  stop(): void {
    for (const a of this.actives) this.cancel(a);
    this.actives.length = 0;
    this.tickers.length = 0;
    this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const clock = this.clock;

    const ts = this.tickers, onErr = this.onError;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      safeTick(t, dt, clock - t.t0, onErr);
      if (t.alive) ts[tw++] = t;
    }
    ts.length = tw;

    const arr = this.actives, len = arr.length, dead0 = this.deadSeen;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (a.wakeAt !== DEAD && a.wakeAt <= clock) {
        a.wakeAt = READY;
        this.advance(a, dt);
      }
    }
    if (this.deadSeen !== dead0) {
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].wakeAt !== DEAD) arr[w++] = arr[i];
      }
      arr.length = w;
    }
  }

  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t = new Ticker(cb);
    t.t0 = this.clock;
    this.tickers.push(t);
    return () => { t.alive = false; };
  }

  private spawn(
    g: Animator<any>, parent: Active | null,
    onDone: ((v: any) => void) | null = null,
  ): Active {
    const a = new Active(g);
    a.onDone = onDone;
    this.actives.push(a);
    if (this.observer) {
      a.observeId = ++this.nextObserveId;
      this.observer.spawn?.(a.observeId, parent?.observeId || undefined, this.clock, g);
    }
    this.advance(a, undefined);
    return a;
  }

  private cancel(a: Active): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.deadSeen++;
    this.observer?.cancel?.(a.observeId, this.clock);
    const c = a.cleanup; a.cleanup = null; a.onDone = null;
    if (c) c();
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch (e) { this.onError(e); }
  }

  private settle(a: Active, value: unknown, errored: boolean, err: unknown): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.deadSeen++;
    if (errored) {
      this.observer?.error?.(a.observeId, this.clock, err);
      this.onError(err);
    } else {
      this.observer?.complete?.(a.observeId, this.clock, value);
    }
    const cb = a.onDone; a.onDone = null;
    if (cb) cb(errored ? undefined : value, a.kidIdx);
  }

  private advance(a: Active, resume: any): void {
    a.busy = true;
    try {
      let r = a.gen.next(resume);
      while (!r.done) {
        if (a.wakeAt === DEAD) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) { a.wakeAt = this.clock + v; return; }
          r = a.gen.next(0); continue;
        }
        if (typeof v === "function") return this.subscribe(a, v as SuspendFn<any>);
        if (Array.isArray(v)) return this.spawnKids(a, v);
        return this.spawnOne(a, v as Animator<any>);
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

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    let setupOpen = true;
    let subKids: Active[] | null = null;

    const wake = (val?: any): void => {
      if (resumed || a.wakeAt === DEAD) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = READY;
      if (c) c();
      this.advance(a, val);
    };

    const spawn: SpawnFn = <R>(g: Animator<R>, oc?: (v: R) => void) => {
      if (!setupOpen) throw new Error("minim: SuspendFn spawn called outside setup window");
      const c = this.spawn(g, a, oc as any);
      (subKids ??= []).push(c);
      return () => this.cancel(c);
    };

    const userDispose = impl(wake, spawn, this);
    setupOpen = false;

    const dispose: () => void = subKids === null ? userDispose : (): void => {
      try { userDispose(); } catch (e) { this.onError(e); }
      if (subKids) {
        const ks = subKids; subKids = null;
        for (const c of ks) if (c.wakeAt !== DEAD) this.cancel(c);
      }
    };

    if (resumed || a.wakeAt === DEAD) {
      try { dispose(); } catch (e) { this.onError(e); }
    } else {
      a.wakeAt = PARKED;
      a.cleanup = dispose;
    }
  }

  /** Single-child fast path. Resume parent with child's return value. */
  private spawnOne(a: Active, child: Animator<any>): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== DEAD) this.cancel(c); };
    c = this.spawn(child, a, (v: any) => {
      if (a.wakeAt === PARKED && a.cleanup !== null) {
        a.cleanup = null;
        a.wakeAt = READY;
        this.advance(a, v);
      }
    });
  }

  /** Parallel-all. Resume parent with [r0, r1, …]. Empty resumes with [].
   *  Uses a single shared `onChild` closure; each spawned child stores
   *  its slot index on its Active so settle() can write into results
   *  without per-child closure allocation. */
  private spawnKids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, []);
    const children: Active[] = [];
    const results: any[] = new Array(kids.length);
    let left = kids.length;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
    };
    const onChild = (v: any, idx: number): void => {
      results[idx] = v;
      if (--left === 0 && a.cleanup !== null && a.wakeAt !== DEAD) {
        a.cleanup = null;
        a.wakeAt = READY;
        this.advance(a, results);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt === DEAD) return;
      const k = kids[j];
      const child = this.spawn(isGen(k) ? k : asGen(k), a, onChild as any);
      child.kidIdx = j;
      children.push(child);
    }
  }
}

export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, anim) =>
    anim.onFrame((dt, t) => { if (step(dt, t) === false) wake(); }),
  );
}
