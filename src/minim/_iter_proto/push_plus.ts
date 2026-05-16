// Push runtime + iterator-era ergonomics. Identical semantics to
// `_anim_proto/v4_protocol.ts` plus three additive features:
//
//   1. `Promise<T>` is a Yieldable. The runtime parks the active
//      until the promise resolves (or rejects → propagate as throw).
//      Closes the gap with co/redux-saga without a SuspendFn shim.
//
//   2. `gen.throw(reason)` for cancel-with-reason. `run(g)` returns a
//      handle whose `.cancel(reason?)` injects `reason` into the
//      cancelled active's `try/catch`. Plain () => void disposer is
//      preserved for back-compat by virtue of the handle being callable.
//
//   3. `Symbol.dispose` on the run handle for `using` scopes.
//
// All three are <30 LoC of additions. The hot path (`advance` →
// numeric / undefined / array dispatch) is untouched, so the bench
// expectation is "no measurable regression".

export type Yieldable =
  | number | undefined | Animator<any> | Yieldable[] | SuspendFn<any> | PromiseLike<any>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type SpawnFn = <R>(g: Animator<R>, onDone?: (v: R) => void) => () => void;
export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
  anim: Anim,
) => () => void;

const DEAD = -1, READY = 0, PARKED = Infinity;
const isThenable = (v: any): v is PromiseLike<any> =>
  v !== null && typeof v === "object" && typeof (v as any).then === "function";

export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}
const isGen = (v: any): v is Animator<any> => typeof v?.next === "function";
function* asGen(y: Yieldable): Animator<any> { return yield y; }

class Active {
  wakeAt = READY;
  cleanup: (() => void) | null = null;
  onDone: ((v: any) => void) | null = null;
  busy = false; pendingReturn = false; pendingThrow: unknown = undefined;
  hasPendingThrow = false;
  constructor(readonly gen: Animator<any>) {}
}

interface Ticker { cb: (dt: number, t: number) => void; t0: number; alive: boolean; }
function safeTick(t: Ticker, dt: number, time: number, onErr: (e: unknown) => void): void {
  try { t.cb(dt, time); } catch (e) { onErr(e); t.alive = false; }
}

/** Run handle. Callable (drop-in for `() => void`), cancellable with
 *  reason, and a Disposable for `using` scopes. */
export interface Handle {
  (): void;
  cancel(reason?: unknown): void;
  [Symbol.dispose](): void;
}

export class Anim {
  private as: Active[] = [];
  private ts: Ticker[] = [];
  private dead = 0;
  onError: (e: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t: Ticker = { cb, t0: this.clock, alive: true };
    this.ts.push(t);
    return () => { t.alive = false; };
  }

  run(g: Animator<any> | (() => Animator<any>)): Handle {
    const a = this.sp(typeof g === "function" ? g() : g, null);
    const cancel = (reason?: unknown): void => this.cx(a, reason);
    const h = (() => cancel()) as Handle;
    h.cancel = cancel;
    h[Symbol.dispose] = () => cancel();
    return h;
  }

  stop(): void {
    for (const a of this.as) this.cx(a);
    this.as.length = 0; this.ts.length = 0; this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const c = this.clock, ts = this.ts, onErr = this.onError;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]; if (!t.alive) continue;
      safeTick(t, dt, c - t.t0, onErr);
      if (t.alive) ts[tw++] = t;
    }
    ts.length = tw;
    const as = this.as, len = as.length, d0 = this.dead;
    for (let i = 0; i < len; i++) {
      const a = as[i];
      if (a.wakeAt !== DEAD && a.wakeAt <= c) { a.wakeAt = READY; this.adv(a, dt); }
    }
    if (this.dead !== d0) {
      let w = 0;
      for (let i = 0; i < as.length; i++) if (as[i].wakeAt !== DEAD) as[w++] = as[i];
      as.length = w;
    }
  }

  private sp(g: Animator<any>, _parent: Active | null, onDone: ((v: any) => void) | null = null): Active {
    const a = new Active(g); a.onDone = onDone; this.as.push(a);
    this.adv(a, undefined);
    return a;
  }

  private cx(a: Active, reason?: unknown): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.dead++;
    const c = a.cleanup; a.cleanup = null; a.onDone = null;
    if (c) c();
    if (a.busy) {
      a.pendingReturn = true;
      if (reason !== undefined) { a.pendingThrow = reason; a.hasPendingThrow = true; }
      return;
    }
    try {
      if (reason !== undefined) a.gen.throw(reason);
      else a.gen.return(undefined);
    } catch (e) { if (e !== reason) this.onError(e); }
  }

  private settle(a: Active, value: unknown, errored: boolean, err: unknown): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.dead++;
    if (errored) this.onError(err);
    const cb = a.onDone; a.onDone = null;
    if (cb) cb(errored ? undefined : value);
  }

  private adv(a: Active, resume: any): void {
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
        if (typeof v === "function") return this.sub(a, v as SuspendFn<any>);
        if (Array.isArray(v)) return this.kids(a, v);
        if (isThenable(v)) return this.thenable(a, v);
        return this.one(a, v as Animator<any>);
      }
      this.settle(a, r.value, false, undefined);
    } catch (e) {
      this.settle(a, undefined, true, e);
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        const had = a.hasPendingThrow; const reason = a.pendingThrow;
        a.hasPendingThrow = false; a.pendingThrow = undefined;
        try {
          if (had) a.gen.throw(reason);
          else a.gen.return(undefined);
        } catch (e) { if (e !== reason) this.onError(e); }
      }
    }
  }

  private thenable(a: Active, p: PromiseLike<any>): void {
    a.wakeAt = PARKED;
    let settled = false;
    a.cleanup = () => { settled = true; };
    p.then(
      (v) => {
        if (settled || a.wakeAt === DEAD) return;
        settled = true; a.cleanup = null; a.wakeAt = READY;
        this.adv(a, v);
      },
      (e) => {
        if (settled || a.wakeAt === DEAD) return;
        settled = true; a.cleanup = null; a.wakeAt = READY;
        try { a.gen.throw(e); } catch (err) { this.settle(a, undefined, true, err); }
      },
    );
  }

  private sub(a: Active, impl: SuspendFn<any>): void {
    let resumed = false, setupOpen = true;
    let subKids: Active[] | null = null;

    const wake = (val?: any): void => {
      if (resumed || a.wakeAt === DEAD) return;
      resumed = true;
      const c = a.cleanup; a.cleanup = null;
      a.wakeAt = READY;
      if (c) c();
      this.adv(a, val);
    };

    const spawn: SpawnFn = <R>(g: Animator<R>, oc?: (v: R) => void) => {
      if (!setupOpen) throw new Error("minim: SuspendFn spawn called outside setup window");
      const c = this.sp(g, a, oc as any);
      (subKids ??= []).push(c);
      return () => this.cx(c);
    };

    const userDispose = impl(wake, spawn, this);
    setupOpen = false;

    const dispose: () => void = subKids === null ? userDispose : (): void => {
      try { userDispose(); } catch (e) { this.onError(e); }
      if (subKids) {
        const ks = subKids; subKids = null;
        for (const c of ks) if (c.wakeAt !== DEAD) this.cx(c);
      }
    };
    if (resumed || a.wakeAt === DEAD) { try { dispose(); } catch (e) { this.onError(e); } }
    else { a.wakeAt = PARKED; a.cleanup = dispose; }
  }

  private one(a: Active, child: Animator<any>): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== DEAD) this.cx(c); };
    c = this.sp(child, a, (v: any) => {
      if (a.wakeAt === PARKED && a.cleanup !== null) {
        a.cleanup = null; a.wakeAt = READY; this.adv(a, v);
      }
    });
  }

  private kids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.adv(a, []);
    const children: Active[] = [];
    const results: any[] = new Array(kids.length);
    let left = kids.length;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt !== DEAD) this.cx(c);
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt === DEAD) return;
      const k = kids[j], idx = j;
      children.push(this.sp(isGen(k) ? k : asGen(k), a, (v: any) => {
        results[idx] = v;
        if (--left === 0 && a.cleanup !== null && a.wakeAt !== DEAD) {
          a.cleanup = null; a.wakeAt = READY; this.adv(a, results);
        }
      }));
    }
  }
}

export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, anim) =>
    anim.onFrame((dt, t) => { if (step(dt, t) === false) wake(); }),
  );
}
