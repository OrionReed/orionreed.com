// Effect-style runtime. One yieldable shape; everything else userland.
//
//   type Effect<T> = (wake: (v: T) => void, anim: Anim) => () => void;
//   type Animator<R> = Generator<Effect<any>, R, any>;
//
// The engine never branches on the yielded value's *kind* — it only
// calls it. The compositional surface (sleep / frame / all / race /
// child / fromPromise / withTimeout / …) lives in userland as 3-line
// constructors. This is what "embarrassingly compositional" means
// concretely: every combinator is a closure that wires `wake`s and
// disposers; nothing requires engine support.
//
// Promise sugar: a yielded thenable is auto-wrapped via fromPromise.
// Costs one branch in the hot path but keeps the ergonomics of
// `const v = yield somePromise;` that motivated this whole exploration.
//
// Shape comparison (engine-only LoC):
//   v4_protocol     ≈ 200  LoC   (Yieldable union of 5)
//   push_plus       ≈ 220  LoC   (+ Promise / throw / dispose)
//   effect (this)   ≈  60  LoC   engine + ≈ 80 LoC stdlib of effects
//
// Trade: every yield allocates an Effect closure. For per-frame loops
// you avoid the cost by using `drive(cb)` (single onFrame registration,
// no per-frame yield). The bench section probes whether this lands.

export type Effect<T = void> = (
  wake: (v: T) => void,
  anim: Anim,
) => () => void;
export type Animator<R = void> = Generator<Effect<any> | PromiseLike<any>, R, any>;

const isThenable = (v: any): v is PromiseLike<any> =>
  v !== null && typeof v === "object" && typeof (v as any).then === "function";

// ─────────────────────────────── engine ───────────────────────────────

interface Listener { cb: (dt: number, t: number) => void; t0: number; alive: boolean; }

export class Anim {
  private ls: Listener[] = [];
  private alives = new Set<() => void>();
  onError: (e: unknown) => void = (e) => { console.error("minim:", e); };
  clock = 0;

  onFrame(cb: (dt: number, t: number) => void): () => void {
    const l: Listener = { cb, t0: this.clock, alive: true };
    this.ls.push(l);
    return () => { l.alive = false; };
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const ls = this.ls, c = this.clock, onErr = this.onError;
    const len = ls.length;
    let w = 0;
    for (let i = 0; i < len; i++) {
      const l = ls[i]; if (!l.alive) continue;
      try { l.cb(dt, c - l.t0); } catch (e) { onErr(e); l.alive = false; }
      if (l.alive) ls[w++] = l;
    }
    if (ls.length > len) {
      for (let i = len; i < ls.length; i++) ls[w++] = ls[i];
    }
    ls.length = w;
  }

  run<R>(g: Animator<R> | (() => Animator<R>), onDone?: (v: R) => void): () => void {
    return spawn(this, typeof g === "function" ? g() : g, onDone);
  }

  stop(): void {
    for (const cancel of [...this.alives]) cancel();
    this.alives.clear();
    this.ls.length = 0;
    this.clock = 0;
  }
}

function spawn<R>(
  anim: Anim, g: Animator<R>, onDone?: (v: R) => void,
): () => void {
  let dead = false, busy = false;
  let cleanup: (() => void) | null = null;

  const finish = (v: any, errored: boolean, err?: unknown): void => {
    if (dead) return;
    dead = true;
    anim["alives"].delete(cancel);
    const c = cleanup; cleanup = null;
    if (c) try { c(); } catch (e) { anim.onError(e); }
    if (errored) anim.onError(err);
    else onDone?.(v);
  };

  const adv = (initial?: any): void => {
    if (dead) return;
    busy = true;
    let resume = initial;
    try {
      while (!dead) {
        const r = g.next(resume); resume = undefined;
        if (r.done) { finish(r.value, false); return; }
        const y = r.value;
        const eff: Effect<any> = isThenable(y) ? fromPromise(y) : (y as Effect<any>);

        let inSubscribe = true;
        let syncWake = false;
        let syncValue: any;
        const wake = (v: any): void => {
          if (dead) return;
          if (inSubscribe) { syncWake = true; syncValue = v; }
          else adv(v);
        };

        const c = eff(wake, anim);
        inSubscribe = false;

        if (dead) { try { c(); } catch (e) { anim.onError(e); } return; }
        if (syncWake) {
          try { c(); } catch (e) { anim.onError(e); }
          resume = syncValue;
          continue;
        }
        cleanup = c;
        return;
      }
    } catch (e) {
      finish(undefined, true, e);
    } finally { busy = false; }
  };

  const cancel = (): void => {
    if (dead) return;
    dead = true;
    anim["alives"].delete(cancel);
    const c = cleanup; cleanup = null;
    if (c) try { c(); } catch (e) { anim.onError(e); }
    if (!busy) try { g.return(undefined); } catch (e) { anim.onError(e); }
  };

  anim["alives"].add(cancel);
  adv();
  return cancel;
}

// ─────────────────────────── effect constructors ───────────────────────────

/** Park 1 frame; resume with dt. */
export const frame: Effect<number> = (wake, anim) => {
  let live = true;
  const off = anim.onFrame((dt) => {
    if (!live) return;
    live = false; off(); wake(dt);
  });
  return () => { live = false; off(); };
};

/** Sleep N seconds; resume with elapsed. */
export const sleep = (s: number): Effect<number> => (wake, anim) => {
  if (s <= 0) { wake(0); return () => {}; }
  let acc = 0, live = true;
  const off = anim.onFrame((dt) => {
    if (!live) return;
    acc += dt;
    if (acc >= s) { live = false; off(); wake(acc); }
  });
  return () => { live = false; off(); };
};

/** Per-frame callback; complete by returning false. */
export const drive = (cb: (dt: number, t: number) => boolean | void): Effect<void> =>
  (wake, anim) => {
    const off = anim.onFrame((dt, t) => {
      if (cb(dt, t) === false) { off(); wake(); }
    });
    return off;
  };

/** Spawn child as sibling; resume with R. Cancels child if parent disposes. */
export const child = <R>(g: Animator<R>): Effect<R> =>
  (wake, anim) => anim.run(g, wake);

/** Wrap a promise. Rejection routes via anim.onError + cancel. */
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

/** Race; resume with first to settle. Cancels the rest. */
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

/** Race vs an internal timeout; resume with `kind: "ok"|"timeout"`. */
export const withTimeout = <T>(
  e: Effect<T>, seconds: number,
): Effect<{ kind: "ok"; value: T } | { kind: "timeout" }> =>
  race([
    ((wake, anim) => e((v) => wake({ kind: "ok", value: v }), anim)) as Effect<any>,
    ((wake, anim) => sleep(seconds)((_) => wake({ kind: "timeout" }), anim)) as Effect<any>,
  ]) as Effect<any>;

/** Subscribe to an external event source; resume on first event. */
export const fromEvent = <T>(
  subscribe: (emit: (v: T) => void) => () => void,
): Effect<T> => (wake) => {
  let live = true;
  const off = subscribe((v) => { if (!live) return; live = false; off(); wake(v); });
  return () => { live = false; off(); };
};
