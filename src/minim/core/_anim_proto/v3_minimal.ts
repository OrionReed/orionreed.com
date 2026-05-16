// v3: same contract as v2, written as tightly as possible. Goal: see
// how small the runtime can get while keeping every test green and
// without regressing the bench. Drops `Ticker` class + `safeTick`
// helper; inlines spawnOne into spawnKids; settles via a single
// terminal helper.

export type Yieldable =
  | number | undefined | Animator<any> | Yieldable[] | SuspendFn<any>;
export type Animator<R = void> = Generator<Yieldable, R, number>;
export type PayloadOf<Y> =
  Y extends Animator<infer R> ? R : Y extends SuspendFn<infer R> ? R : void;
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
export const isGen = (v: any): v is Animator<any> => typeof v?.next === "function";
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
  onDone: ((v: any) => void) | null = null;
  busy = false; pendingReturn = false; observeId = 0;
  constructor(readonly gen: Animator<any>) {}
}

interface Ticker { cb: (dt: number, t: number) => void; t0: number; alive: boolean; }

/** Hoisted to keep the step()-ticker loop catch-free. */
function safeTick(t: Ticker, dt: number, time: number, onErr: (e: unknown) => void): void {
  try { t.cb(dt, time); } catch (e) { onErr(e); t.alive = false; }
}

export class Anim {
  private as: Active[] = [];
  private ts: Ticker[] = [];
  private dead = 0;
  private nid = 0;
  observer: AnimObserver | undefined;
  onError: (e: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  run(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.sp(typeof g === "function" ? g() : g, null);
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
      if (a.wakeAt !== DEAD && a.wakeAt <= c) { a.wakeAt = READY; this.adv(a, dt); }
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

  private sp(g: Animator<any>, parent: Active | null, onDone: ((v: any) => void) | null = null): Active {
    const a = new Active(g); a.onDone = onDone; this.as.push(a);
    if (this.observer) {
      a.observeId = ++this.nid;
      this.observer.spawn?.(a.observeId, parent?.observeId || undefined, this.clock, g);
    }
    this.adv(a, undefined);
    return a;
  }

  private cx(a: Active): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.dead++;
    this.observer?.cancel?.(a.observeId, this.clock);
    const c = a.cleanup; a.cleanup = null; a.onDone = null;
    if (c) c();
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch (e) { this.onError(e); }
  }

  private settle(a: Active, value: unknown, err: unknown, errored: boolean): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD; this.dead++;
    if (errored) { this.observer?.error?.(a.observeId, this.clock, err); this.onError(err); }
    else this.observer?.complete?.(a.observeId, this.clock, value);
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
        return this.one(a, v as Animator<any>);
      }
      this.settle(a, r.value, undefined, false);
    } catch (e) {
      this.settle(a, undefined, e, true);
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try { a.gen.return(undefined); } catch (e) { this.onError(e); }
      }
    }
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
    c = this.sp(child, a, () => {
      if (a.wakeAt === PARKED && a.cleanup !== null) {
        a.cleanup = null; a.wakeAt = READY;
        this.adv(a, undefined);
      }
    });
  }

  private kids(a: Active, ys: Yieldable[]): void {
    if (ys.length === 0) return this.adv(a, undefined);
    const children: Active[] = [];
    let left = ys.length;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt !== DEAD) this.cx(c);
    };
    const onChild = (): void => {
      if (--left === 0 && a.cleanup !== null && a.wakeAt !== DEAD) {
        a.cleanup = null; a.wakeAt = READY;
        this.adv(a, undefined);
      }
    };
    for (let j = 0; j < ys.length; j++) {
      if (a.wakeAt === DEAD) return;
      const k = ys[j];
      children.push(this.sp(isGen(k) ? k : asGen(k), a, onChild));
    }
  }
}

export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, anim) =>
    anim.onFrame((dt, t) => { if (step(dt, t) === false) wake(); }),
  );
}
