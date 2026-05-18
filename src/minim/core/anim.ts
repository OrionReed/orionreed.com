// Generator-driven cooperative animation runtime.
//
// Yield contract:
//   undefined        park 1 frame; resume with dt
//   number > 0       sleep N seconds; resume with dt of waking step
//   number ≤ 0       tail-call; resume immediately with the next yield
//   Animator         spawn child; resume with R when it completes
//   Yieldable[]      parallel-all; resume with results[] when all done
//   SuspendFn        callback wake; resume with wake's value
//   PromiseLike<T>   await; resume with T (or throw on reject)
//   detach(g)        spawn `g` at engine-root; resume immediately
//
// Errors propagate via `gen.throw()` to the parent's yield site.
// Cancel via `gen.return()` (silent; runs `try/finally`).
//
// One state machine (Active = generator + wakeAt + parent), one
// resumption seam (gen.next(dt)), one composition rule (yield/yield*),
// one escape hatch (detach). Per-frame work (drive, every) is just
// generators that `while(true) yield;` — no special engine support.

const DEAD = -Infinity;
const READY = 0;
const PARKED = Infinity;

const DETACH_KEY = Symbol.for("minim.detach");

export type Yieldable =
  | undefined
  | number
  | Animator<any>
  | readonly Yieldable[]
  | SuspendFn<any>
  | PromiseLike<unknown>
  | Detach;
export type Animator<R = void> = Generator<Yieldable, R, number>;
export type Wake<T = void> = ([T] extends [void]
  ? () => void
  : (value: T) => void) & { throw(error: unknown): void };

/** Resume payload of a yielded shape — child Animator's R, SuspendFn's T,
 *  or void for non-typed yields. */
export type PayloadOf<Y> =
  Y extends Animator<infer R> ? R
  : Y extends SuspendFn<infer R> ? R
  : void;

/** Spawn an inner generator from a SuspendFn body; returns a disposer. */
export type SpawnFn = <R>(
  g: Animator<R> | (() => Animator<R>),
  onDone?: (v: R) => void,
) => () => void;

/** SuspendFn signature: `(wake, spawn, anim) => dispose`. Return is
 *  optional: scoped children spawned via `spawn` are cancelled
 *  automatically with the parent. */
export type SuspendFn<T = void> = (
  wake: Wake<T>,
  spawn: SpawnFn,
  anim: Anim,
) => void | (() => void);

/** Optional per-engine lifecycle observer (assert/spans). */
export interface AnimObserver {
  spawn?(id: number, parentId: number | undefined, clock: number, gen: Animator<any>): void;
  complete?(id: number, clock: number): void;
  cancel?(id: number, clock: number): void;
}

/** Brand for `detach(g)`. Loosely typed at the symbol level — only the
 *  `detach(...)` helper constructs valid instances. */
export type Detach = { readonly [k: symbol]: Animator };

/** Spawn `g` at engine-root, outliving the yielding parent. Resume is
 *  synchronous (the parent does NOT park). Use sparingly — most
 *  animations should be scoped to their parent's lifetime. */
export const detach = <R>(g: Animator<R>): Detach =>
  ({ [DETACH_KEY]: g as Animator });

export const isGen = (v: unknown): v is Animator =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { next?: unknown }).next === "function";
const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as { then?: unknown }).then === "function";

/** Human-readable summary of an unexpected yield value, for error
 *  messages. Truncates objects + arrays to keep messages skim-able. */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (v instanceof Error) return `Error(${v.message})`;
  const t = typeof v;
  if (t !== "object") return String(v);
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
  // Class-named objects: prefix with the class
  if (ctor && ctor !== "Object") {
    try {
      const j = JSON.stringify(v);
      return j.length > 80 ? `${ctor} ${j.slice(0, 77)}…` : `${ctor} ${j}`;
    } catch { return ctor; }
  }
  // Plain objects: show keys (often clearer than full JSON)
  const keys = Object.keys(v as object);
  if (keys.length === 0) return "{}";
  if (keys.length > 6) return `{ ${keys.slice(0, 6).join(", ")}, … }`;
  return `{ ${keys.join(", ")} }`;
}

/** Wrap any non-generator Yieldable in a one-shot generator. Lets
 *  `yield [0.2, work()]` mix sleeps and gens in parallel. */
export function* asGen(y: Yieldable): Animator<any> { yield y; }

type OnSettle = (v: unknown, err: unknown) => void;

class Active {
  wakeAt = READY;
  cleanup: (() => void) | null = null;
  onSettle: OnSettle | null = null;
  /** Re-entrancy guards — cancel-during-advance defers `gen.return()`. */
  busy = false;
  pendingReturn = false;
  /** Observer ID; 0 means unobserved. */
  observeId = 0;
  parent: Active | null = null;
  constructor(readonly gen: Animator) {}
}

export class Anim {
  protected actives: Active[] = [];
  private deads = 0;
  private nextObserveId = 0;
  /** Lazy: only allocated if there are subscribers. */
  private stepListeners: Set<(dt: number) => void> | null = null;
  observer: AnimObserver | undefined = undefined;
  onError: (e: unknown) => void = (e) => {
    console.error("minim:", e);
  };
  /** Engine time in seconds since last `stop()`. Read-only externally;
   *  internal mutations during `step()` advance it. */
  #clock = 0;
  get clock(): number { return this.#clock; }

  /** Run `g` (or its result if a factory) until it completes; returns
   *  a disposer. */
  start(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(
      (typeof g === "function" ? g() : g) as Animator,
      null,
      null,
    );
    return () => this.cancel(a);
  }

  /** Subscribe to `step()` calls. The callback fires every step with
   *  the same `dt` the engine receives. Use sparingly — for true
   *  animation work prefer a generator that yields per frame, which
   *  composes with `mapDt`/`tap`. Returns a disposer. */
  onStep(cb: (dt: number) => void): () => void {
    (this.stepListeners ??= new Set()).add(cb);
    return () => { this.stepListeners?.delete(cb); };
  }

  /** Cancel everything; reset clock. */
  stop(): void {
    const snap = this.actives.slice();
    this.actives.length = 0;
    this.#clock = 0;
    for (const a of snap) this.cancel(a);
  }

  step(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.#clock += dt;
    const c = this.#clock;
    if (this.stepListeners) {
      for (const cb of this.stepListeners) {
        try { cb(dt); }
        catch (e) { this.onError(e); }
      }
    }
    const as = this.actives;
    const alen = as.length;
    const d0 = this.deads;
    for (let i = 0; i < alen; i++) {
      const a = as[i];
      if (!a || a.wakeAt === DEAD || a.wakeAt === PARKED) continue;
      if (a.wakeAt <= c) {
        a.wakeAt = READY;
        this.advance(a, dt, false);
      }
    }
    if (this.deads !== d0) {
      let cw = 0;
      for (let i = 0; i < as.length; i++)
        if (as[i].wakeAt !== DEAD) as[cw++] = as[i];
      as.length = cw;
      this.deads = 0;
    }
  }

  protected spawn(
    gen: Animator,
    parent: Active | null,
    onSettle: OnSettle | null,
  ): Active {
    const a = new Active(gen);
    a.onSettle = onSettle;
    a.parent = parent;
    this.actives.push(a);
    if (this.observer) {
      a.observeId = ++this.nextObserveId;
      this.observer.spawn?.(
        a.observeId,
        parent?.observeId || undefined,
        this.#clock,
        gen,
      );
    }
    this.advance(a, undefined, false);
    return a;
  }

  protected cancel(a: Active): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD;
    this.deads++;
    this.observer?.cancel?.(a.observeId, this.#clock);
    const c = a.cleanup;
    a.cleanup = null;
    a.onSettle = null;
    this.safe(c);
    if (a.busy) {
      a.pendingReturn = true;
      return;
    }
    try { a.gen.return(undefined); }
    catch (e) { this.onError(e); }
  }

  private safe(fn: (() => void) | null | undefined): void {
    try { fn?.(); }
    catch (e) { this.onError(e); }
  }

  protected settle(
    a: Active,
    value: unknown,
    errored: boolean,
    error: unknown,
  ): void {
    if (a.wakeAt === DEAD) return;
    a.wakeAt = DEAD;
    this.deads++;
    if (!errored) this.observer?.complete?.(a.observeId, this.#clock);
    const cb = a.onSettle;
    a.onSettle = null;
    if (cb) cb(errored ? undefined : value, errored ? error : undefined);
    else if (errored) this.onError(error);
  }

  private advance(a: Active, payload: any, asThrow: boolean): void {
    a.busy = true;
    try {
      let r = asThrow ? a.gen.throw(payload) : a.gen.next(payload);
      while (!r.done) {
        if (a.wakeAt === DEAD) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) {
            a.wakeAt = this.#clock + v;
            return;
          }
          r = a.gen.next(0);
          continue;
        }
        if (typeof v === "function") return this.suspend(a, v);
        if (Array.isArray(v)) return this.parallel(a, v);
        if (isGen(v)) return this.child(a, v);
        if (isThenable(v)) return this.thenable(a, v);
        if (typeof v === "object" && v !== null && DETACH_KEY in v) {
          this.spawn((v as Record<symbol, Animator>)[DETACH_KEY], null, null);
          r = a.gen.next(0);
          continue;
        }
        throw new TypeError(`anim: unsupported yield ${describe(v)}`);
      }
      return this.settle(a, r.value, false, undefined);
    } catch (e) {
      this.settle(a, undefined, true, e);
    } finally {
      a.busy = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        try { a.gen.return(undefined); }
        catch (e) { this.onError(e); }
      }
    }
  }

  private suspend(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const finish = (action: () => void): void => {
      if (resumed || a.wakeAt === DEAD) return;
      resumed = true;
      const c = a.cleanup;
      a.cleanup = null;
      a.wakeAt = READY;
      this.safe(c);
      action();
    };
    const wake = ((v?: unknown) =>
      finish(() => this.advance(a, v, false))) as Wake<any>;
    wake.throw = (e: unknown): void =>
      finish(() => this.advance(a, e, true));
    let subKids: Active[] | null = null;
    const spawnFn: SpawnFn = (g, onDone) => {
      const onSettle: OnSettle | null = onDone
        ? (v, err) => { if (err === undefined) onDone(v as never); }
        : null;
      const child = this.spawn(
        (typeof g === "function" ? g() : g) as Animator,
        a,
        onSettle,
      );
      (subKids ??= []).push(child);
      return () => this.cancel(child);
    };
    let userDispose: (() => void) | undefined;
    try { userDispose = impl(wake, spawnFn, this) ?? undefined; }
    catch (e) {
      if (!resumed && a.wakeAt !== DEAD) {
        resumed = true;
        this.advance(a, e, true);
      } else this.onError(e);
      return;
    }
    // Dispose checks `subKids` at call time (not setup time) — the
    // SuspendFn is allowed to capture `spawn` and call it later, while
    // the parent is still parked. Children attached then must still
    // cascade-cancel.
    const dispose: () => void = () => {
      this.safe(userDispose);
      if (subKids) {
        const ks = subKids;
        subKids = null;
        for (const c of ks) if (c.wakeAt !== DEAD) this.cancel(c);
      }
    };
    if (resumed || a.wakeAt === DEAD) this.safe(dispose);
    else {
      a.wakeAt = PARKED;
      a.cleanup = dispose;
    }
  }

  private thenable(a: Active, p: PromiseLike<unknown>): void {
    a.wakeAt = PARKED;
    let cancelled = false;
    a.cleanup = () => { cancelled = true; };
    p.then(
      (v) => {
        if (!cancelled && a.wakeAt !== DEAD) {
          a.cleanup = null;
          a.wakeAt = READY;
          this.advance(a, v, false);
        }
      },
      (e) => {
        if (!cancelled && a.wakeAt !== DEAD) {
          a.cleanup = null;
          a.wakeAt = READY;
          this.advance(a, e, true);
        }
      },
    );
  }

  private child(a: Active, child: Animator): void {
    a.wakeAt = PARKED;
    let c: Active | null = null;
    a.cleanup = () => { if (c && c.wakeAt !== DEAD) this.cancel(c); };
    c = this.spawn(child, a, (v, err) => {
      if (a.wakeAt === DEAD || a.cleanup === null) return;
      a.cleanup = null;
      a.wakeAt = READY;
      this.advance(a, err === undefined ? v : err, err !== undefined);
    });
  }

  private parallel(a: Active, kids: readonly Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, [], false);
    const children: Active[] = [];
    const results = new Array<unknown>(kids.length);
    let left = kids.length;
    let aborted = false;
    a.wakeAt = PARKED;
    a.cleanup = () => {
      aborted = true;
      for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
    };
    for (let j = 0; j < kids.length; j++) {
      if (aborted) return;
      const k = kids[j];
      const idx = j;
      // Per-kid closure captures `idx` directly — no `slot` field needed
      // on Active. Sync-completing kids settle their slot before the
      // loop progresses, so `results` is correctly indexed.
      children.push(this.spawn(isGen(k) ? k : asGen(k), a, (value, error) => {
        if (aborted) return;
        if (error !== undefined) {
          aborted = true;
          a.cleanup = null;
          a.wakeAt = READY;
          for (const c of children) if (c.wakeAt !== DEAD) this.cancel(c);
          this.advance(a, error, true);
          return;
        }
        results[idx] = value;
        if (--left === 0) {
          aborted = true;
          a.cleanup = null;
          a.wakeAt = READY;
          this.advance(a, results, false);
        }
      }));
    }
  }
}

