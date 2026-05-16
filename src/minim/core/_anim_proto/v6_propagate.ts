// v6: v5 + model-a error propagation for child generators.
//
// Where v5 split the error model (Promise rejects throw, child gen
// throws are silent), v6 unifies: ALL yielded children propagate
// errors via `gen.throw()` into the parent. The yield contract
// becomes self-consistent:
//
//   yield gen      — gen throws → throws into parent at yield site
//   yield [a, b]   — any throws → all others cancel, throws into parent
//   yield promise  — rejects    → throws into parent (same as v5)
//
// User wants silent? Wrap: `function*(g) { try { yield* g; } catch {} }`.
// User wants "yield gen and ignore errors"? `yield ignoreErrors(gen())`.
//
// Question this design pins: it BREAKS the failing test "child throw
// doesn't hang parent" (which asserts `parentDone = true` after a
// throwing sibling). The right answer for that test under v6 is:
// rewrite to `try { yield [...] } catch (e) { parentDone = true; }`.
//
// Note: errors are still silent for the OBSERVER's `error` hook and
// `anim.onError` — but at the TOP-level only (where they're truly
// unhandled). If a parent catches via try/catch, it's not unhandled.
//
// New yieldables (vs v4c):
//   * `Promise<T>` — runtime calls `.then(wake, rethrow)`. Rejection
//     becomes `gen.throw()` into the parent at the yield site. This
//     matches `await` in async functions.
//
// New ergonomics:
//   * `anim.run()` returns a disposer fn that ALSO has `[Symbol.dispose]`,
//     so `using stop = anim.run(...)` works.
//
// Error model split (intentional):
//   * Yielded Animator throws    → parent resumes with `undefined`,
//                                  error → onError + observer (model-b)
//   * Yielded Promise rejects    → throws into parent via gen.throw()
//                                  (model-a)
//
// Why split? In JS, `Promise.reject` and a generator that throws are
// already different mechanisms. Async/await users expect rejection to
// propagate; engine-spawned active failures expect to be isolated. The
// boundary is the yielded value's shape — Promise (model-a) vs
// Animator (model-b).

export type Yieldable =
  | number | undefined | Animator<any> | Yieldable[] | SuspendFn<any>
  | PromiseLike<any>;
export type Animator<R = void> = Generator<Yieldable, R, any>;
export type PayloadOf<Y> =
  Y extends Animator<infer R> ? R
  : Y extends SuspendFn<infer R> ? R
  : Y extends PromiseLike<infer R> ? R
  : void;

const isThenable = (v: any): v is PromiseLike<any> =>
  v != null && typeof v.then === "function";
export type SpawnFn = <R>(g: Animator<R>, onDone?: (v: R) => void) => () => void;
export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
  anim: Anim,
) => () => void;

const DEAD = -1, READY = 0, PARKED = Infinity;

/** Callable disposer that also implements `[Symbol.dispose]` for
 *  `using` syntax. Calling it or letting it fall out of a `using`
 *  scope are equivalent. */
export interface RunHandle {
  (): void;
  [Symbol.dispose](): void;
}

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
  /** Parent-resume callback. Called with (value, idx, err) where err is
   *  undefined on natural completion, defined on throw. Errored
   *  children fire this with err defined; parents propagate via
   *  gen.throw if they don't catch. */
  onDone: ((v: any, idx: number, err: unknown) => void) | null = null;
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

  run(g: Animator<any> | (() => Animator<any>)): RunHandle {
    const a = this.spawn(typeof g === "function" ? g() : g, null);
    const dispose = (): void => this.cancel(a);
    (dispose as any)[Symbol.dispose] = dispose;
    return dispose as RunHandle;
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
    if (errored) this.observer?.error?.(a.observeId, this.clock, err);
    else this.observer?.complete?.(a.observeId, this.clock, value);
    const cb = a.onDone; a.onDone = null;
    if (cb) cb(errored ? undefined : value, a.kidIdx, errored ? err : undefined);
    else if (errored) this.onError(err);  // root/detached only
  }

  private advance(a: Active, resume: any, asThrow = false): void {
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
        if (typeof v === "function") return this.subscribe(a, v as SuspendFn<any>);
        if (Array.isArray(v)) return this.spawnKids(a, v);
        if (isThenable(v)) return this.subscribePromise(a, v);
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

  /** Park on a Promise. Resolve → resume with value; reject → throw
   *  into the parent generator. Late resolution after cancel is ignored
   *  (the registered rejection handler suppresses unhandled-rejection
   *  warnings). */
  private subscribePromise(a: Active, p: PromiseLike<any>): void {
    let cancelled = false;
    a.wakeAt = PARKED;
    a.cleanup = (): void => { cancelled = true; };
    p.then(
      (v: any) => {
        if (cancelled || a.wakeAt === DEAD) return;
        a.cleanup = null; a.wakeAt = READY;
        this.advance(a, v);
      },
      (e: any) => {
        if (cancelled || a.wakeAt === DEAD) return;
        a.cleanup = null; a.wakeAt = READY;
        this.advance(a, e, true);
      },
    );
  }

  /** Single-child fast path. Resume parent with child's return value;
   *  on child error, propagate via `gen.throw` into the parent. */
  private spawnOne(a: Active, child: Animator<any>): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== DEAD) this.cancel(c); };
    c = this.spawn(child, a, (v: any, _idx: number, err: unknown) => {
      if (a.wakeAt === PARKED && a.cleanup !== null) {
        a.cleanup = null;
        a.wakeAt = READY;
        if (err !== undefined) this.advance(a, err, true);
        else this.advance(a, v);
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
    const onChild = (v: any, idx: number, err: unknown): void => {
      if (err !== undefined && a.cleanup !== null && a.wakeAt !== DEAD) {
        // Cancel surviving siblings and throw into parent.
        const c = a.cleanup; a.cleanup = null;
        a.wakeAt = READY;
        if (c) c();
        this.advance(a, err, true);
        return;
      }
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
