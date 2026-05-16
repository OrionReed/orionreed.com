// v1: constants for wakeAt's encoded states + inline state predicates.
// Behaviour identical to v0_baseline. Goal: readability without paying
// a perf tax. Bench against v0 to confirm.
//
// wakeAt encoding:
//   DEAD     (-1)        cancelled or completed
//   READY    ( 0)         ready to advance this step
//   PARKED   (Infinity)   waiting on suspend/children
//   finite>0              sleeping until that engine-clock value

export type Yieldable =
  | number | undefined | Animator<any> | Yieldable[] | SuspendFn<any>;
export type Animator<R = void> = Generator<Yieldable, R, number>;
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

const DEAD = -1;
const READY = 0;
const PARKED = Infinity;

export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

export const isGen = (v: any): v is Animator<any> =>
  typeof v?.next === "function";

function* asGen(y: Yieldable): Animator<any> { yield y; }

export interface AnimObserver {
  spawn?(id: number, parentId: number | undefined, clock: number, gen: Animator<any>): void;
  complete?(id: number, clock: number): void;
  cancel?(id: number, clock: number): void;
}

class Active {
  wakeAt = READY;
  cleanup: (() => void) | null = null;
  onDone: ((v: any) => void) | null = null;
  busy = false;
  pendingReturn = false;
  observeId = 0;
  constructor(readonly gen: Animator<any>) {}
}

class Ticker {
  alive = true;
  t0 = 0;
  constructor(readonly cb: (dt: number, t: number) => void) {}
}

function safeTick(t: Ticker, dt: number, time: number): void {
  try { t.cb(dt, time); }
  catch (e) { console.error("minim:", e); t.alive = false; }
}

export class Anim {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  private deadSeen = 0;
  private nextObserveId = 0;
  observer: AnimObserver | undefined = undefined;
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

    const ts = this.tickers;
    let tw = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t.alive) continue;
      safeTick(t, dt, clock - t.t0);
      if (t.alive) ts[tw++] = t;
    }
    ts.length = tw;

    const arr = this.actives;
    const len = arr.length;
    const dead0 = this.deadSeen;
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
    g: Animator<any>,
    parent: Active | null,
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
    const c = a.cleanup; a.cleanup = null;
    if (c) c();
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch {}
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
      if (a.wakeAt === DEAD) return;
      a.wakeAt = DEAD; this.deadSeen++;
      this.observer?.complete?.(a.observeId, this.clock);
      const cb = a.onDone; a.onDone = null;
      if (cb) cb(r.value);
    } catch (e) {
      console.error("minim:", e);
      if (a.wakeAt !== DEAD) { a.wakeAt = DEAD; this.deadSeen++; }
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try { a.gen.return(undefined); } catch {}
      }
    }
  }

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
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
      const c = this.spawn(g, a, oc as any);
      (subKids ??= []).push(c);
      return () => this.cancel(c);
    };

    const userDispose = impl(wake, spawn, this);

    const dispose: () => void = subKids === null
      ? userDispose
      : (): void => {
          try { userDispose(); } catch (e) { console.error("minim:", e); }
          if (subKids) {
            const ks = subKids; subKids = null;
            for (const c of ks) if (c.wakeAt !== DEAD) this.cancel(c);
          }
        };

    if (resumed || a.wakeAt === DEAD) {
      try { dispose(); } catch {}
    } else {
      a.wakeAt = PARKED;
      a.cleanup = dispose;
    }
  }

  private spawnOne(a: Active, child: Animator<any>): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== DEAD) this.cancel(c); };
    c = this.spawn(child, a, () => {
      if (a.wakeAt === PARKED && a.cleanup !== null) {
        a.cleanup = null;
        a.wakeAt = READY;
        this.advance(a, undefined);
      }
    });
  }

  private spawnKids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, undefined);
    const children: Active[] = [];
    let left = kids.length;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
    };
    const onChild = (): void => {
      if (--left === 0 && a.cleanup !== null && a.wakeAt !== DEAD) {
        a.cleanup = null;
        a.wakeAt = READY;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.wakeAt === DEAD) return;
      const k = kids[j];
      const child = this.spawn(isGen(k) ? k : asGen(k), a, onChild);
      children.push(child);
    }
  }
}

export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, anim) =>
    anim.onFrame((dt, t) => { if (step(dt, t) === false) wake(); }),
  );
}
