// Effect-style runtime with two engine-native fast paths.
//
//   Yieldable = undefined | number | PromiseLike | Effect<T>
//
// `undefined` (park 1 frame) and `number` (sleep N s) are the two
// hot-loop primitives that dominate generator-driven animation. Making
// them allocation-free in the engine recovers most of the perf gap
// vs v4, while the Effect shape continues to carry composition.
//
// Engine knows about:
//   • undefined → push `wake` onto an internal "park" list; flushed
//     each `step` with the elapsed dt
//   • number    → store wakeAt sentinel; step wakes when clock crosses
//   • PromiseLike → auto-wrap as fromPromise
//   • Effect    → call `eff(wake, anim)`; store its dispose
//
// Userland constructors (frame / sleep / drive / child / all / race /
// withTimeout / fromPromise) are unchanged from `effect.ts`. The
// `frame` constructor still works but a bare `yield;` is allocation-free
// and preferred in hot loops.
//
// Active is a class with stable hidden shape; one allocation per spawn.
// Cancel handles live in an array (not a Set).

export type Effect<T = void> = (
  wake: (v: T) => void,
  anim: Anim,
) => () => void;
export type Yieldable<T = any> = undefined | number | PromiseLike<T> | Effect<T>;
export type Animator<R = void> = Generator<Yieldable<any>, R, any>;

const isThenable = (v: any): v is PromiseLike<any> =>
  v !== null && typeof v === "object" && typeof (v as any).then === "function";

// ─────────────────────────────── engine ───────────────────────────────

interface Listener { cb: (dt: number, t: number) => void; t0: number; alive: boolean; }

/** Hoisted to keep `step`'s listener loop catch-free, so V8 can inline. */
function safeTick(l: Listener, dt: number, t: number, onErr: (e: unknown) => void): void {
  try { l.cb(dt, t); } catch (e) { onErr(e); l.alive = false; }
}

class Active {
  dead = false; busy = false;
  cleanup: (() => void) | null = null;
  inSubscribe = false; syncWake = false; syncValue: any = undefined;
  /** Sentinel for sleep: -1 means "not sleeping". */
  wakeAt = -1;
  wakeSelf: (v?: any) => void;

  constructor(
    readonly gen: Animator<any>,
    readonly anim: Anim,
    readonly onDone: ((v: any) => void) | null,
  ) {
    this.wakeSelf = (v?: any) => {
      if (this.dead) return;
      if (this.inSubscribe) { this.syncWake = true; this.syncValue = v; }
      else this.adv(v);
    };
  }

  adv(initial?: any): void {
    if (this.dead) return;
    this.busy = true;
    let resume = initial;
    try {
      while (!this.dead) {
        const r = this.gen.next(resume);
        resume = undefined;
        if (r.done) { this.finish(r.value, false); return; }
        const y = r.value;

        if (y === undefined) {
          this.anim["parks"].push(this);
          return;
        }
        if (typeof y === "number") {
          if (y > 0) {
            this.wakeAt = this.anim.clock + y;
            this.anim["sleepers"].push(this);
            return;
          }
          continue;
        }

        const eff: Effect<any> = isThenable(y)
          ? ((wake, anim) => {
              let live = true;
              y.then(
                (v) => { if (live) wake(v); },
                (e) => { if (live) { live = false; anim.onError(e); } },
              );
              return () => { live = false; };
            })
          : (y as Effect<any>);

        this.inSubscribe = true; this.syncWake = false;
        const c = eff(this.wakeSelf, this.anim);
        this.inSubscribe = false;
        if (this.dead) { try { c(); } catch (e) { this.anim.onError(e); } return; }
        if (this.syncWake) {
          try { c(); } catch (e) { this.anim.onError(e); }
          resume = this.syncValue;
          this.syncValue = undefined;
          continue;
        }
        this.cleanup = c;
        return;
      }
    } catch (e) {
      this.finish(undefined, true, e);
    } finally {
      this.busy = false;
    }
  }

  finish(v: any, errored: boolean, err?: unknown): void {
    if (this.dead) return;
    this.dead = true;
    const c = this.cleanup; this.cleanup = null;
    if (c) try { c(); } catch (e) { this.anim.onError(e); }
    if (errored) this.anim.onError(err);
    else this.onDone?.(v);
  }

  cancel(): void {
    if (this.dead) return;
    this.dead = true;
    const c = this.cleanup; this.cleanup = null;
    if (c) try { c(); } catch (e) { this.anim.onError(e); }
    if (!this.busy) {
      try { this.gen.return(undefined); } catch (e) { this.anim.onError(e); }
    }
  }
}

export class Anim {
  private ls: Listener[] = [];
  private parks: Active[] = [];
  private sleepers: Active[] = [];
  onError: (e: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  onFrame(cb: (dt: number, t: number) => void): () => void {
    const l: Listener = { cb, t0: this.clock, alive: true };
    this.ls.push(l);
    return () => { l.alive = false; };
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const c = this.clock, ls = this.ls, onErr = this.onError;

    // 1. drive listeners
    {
      const len = ls.length;
      let w = 0;
      for (let i = 0; i < len; i++) {
        const l = ls[i]; if (!l.alive) continue;
        safeTick(l, dt, c - l.t0, onErr);
        if (l.alive) ls[w++] = l;
      }
      if (ls.length > len) for (let i = len; i < ls.length; i++) ls[w++] = ls[i];
      ls.length = w;
    }

    // 2. 1-frame parks: wake all in batch; new parks arriving during
    //    wake go to the fresh list (since we swap before iterating).
    if (this.parks.length) {
      const ps = this.parks;
      this.parks = [];
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i]; if (a.dead) continue;
        a.adv(dt);
      }
    }

    // 3. sleepers: wake those whose wakeAt has passed
    if (this.sleepers.length) {
      const ss = this.sleepers;
      let w = 0;
      for (let i = 0; i < ss.length; i++) {
        const a = ss[i];
        if (a.dead) continue;
        if (a.wakeAt <= c) { a.wakeAt = -1; a.adv(0); }
        else ss[w++] = a;
      }
      ss.length = w;
    }
  }

  run<R>(g: Animator<R> | (() => Animator<R>), onDone?: (v: R) => void): () => void {
    const gen = typeof g === "function" ? g() : g;
    const a = new Active(gen, this, (onDone ?? null) as any);
    a.adv();
    return () => a.cancel();
  }

  stop(): void {
    for (const a of this.parks) a.cancel();
    for (const a of this.sleepers) a.cancel();
    this.parks.length = 0;
    this.sleepers.length = 0;
    this.ls.length = 0;
    this.clock = 0;
  }
}

// ─────────────────────────── effect constructors ───────────────────────────

/** Per-frame callback; complete by returning false. */
export const drive = (cb: (dt: number, t: number) => boolean | void): Effect<void> =>
  (wake, anim) => {
    const off = anim.onFrame((dt, t) => {
      if (cb(dt, t) === false) { off(); wake(); }
    });
    return off;
  };

/** Spawn child as sibling; resume with R. */
export const child = <R>(g: Animator<R>): Effect<R> =>
  (wake, anim) => anim.run(g, wake);

/** Wrap a promise. (Auto-applied for bare `yield Promise`.) */
export const fromPromise = <T>(p: PromiseLike<T>): Effect<T> => (wake, anim) => {
  let live = true;
  p.then(
    (v) => { if (live) wake(v); },
    (e) => { if (live) { live = false; anim.onError(e); } },
  );
  return () => { live = false; };
};

/** Wait for all to complete. Empty resolves with []. */
export const all = <T>(es: Effect<T>[]): Effect<T[]> => (wake, anim) => {
  if (es.length === 0) { wake([]); return () => {}; }
  const r = new Array<T>(es.length);
  let left = es.length, settled = false;
  const ds = new Array<() => void>(es.length);
  for (let i = 0; i < es.length; i++) {
    const idx = i;
    ds[idx] = es[idx]((v) => {
      if (settled) return;
      r[idx] = v;
      if (--left === 0) { settled = true; wake(r); }
    }, anim);
    if (settled) break;
  }
  return () => { settled = true; for (const d of ds) d?.(); };
};

/** Race; resume with first to settle. */
export const race = <T>(es: Effect<T>[]): Effect<T> => (wake, anim) => {
  let done = false;
  const ds = new Array<() => void>(es.length);
  for (let i = 0; i < es.length; i++) {
    ds[i] = es[i]((v) => {
      if (done) return;
      done = true;
      for (const d of ds) d?.();
      wake(v);
    }, anim);
    if (done) break;
  }
  return () => { done = true; for (const d of ds) d?.(); };
};

/** Subscribe to an external event source; resume on first event. */
export const fromEvent = <T>(
  subscribe: (emit: (v: T) => void) => () => void,
): Effect<T> => (wake) => {
  let live = true;
  const off = subscribe((v) => { if (!live) return; live = false; off(); wake(v); });
  return () => { live = false; off(); };
};
