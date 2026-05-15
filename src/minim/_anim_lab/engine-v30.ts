// v30 — mini's hot path verbatim. Scale opt-in, attached as a thunk
// that ONLY the scaled subtree pays. Default (unscaled) actives and
// tickers have zero scale overhead — the loop matches mini exactly.
//
// Active fields default to no-scale. When `spawn(...scale)` is called
// with a non-1 scale, the active gets an `effFn` thunk; that thunk is
// captured by any child gen and any ticker spawned inside it.
// Sleeps inside a scaled scope are scaled by reading effFn() at
// registration time. (Reactive scale within a sleep — i.e. scale
// changing mid-sleep — is not supported; v6 was the only engine that
// tracked per-frame ownClock for this, at material per-frame cost.)
//
// What remains on the cold path: scale, dt-resume scaling, sleep-dur
// scaling, observer hooks.

const FRAME_CAP_MS = 32;

export interface RuntimeAccess {
  onFrame(cb: (dt: number, t: number) => void): () => void;
}
export type SpawnFn = <R>(
  g: Animator<R>,
  oc?: (v: R) => void,
  s?: number | (() => number),
) => () => void;
export type SuspendFn<T = void> = (
  wake: [T] extends [void] ? () => void : (v: T) => void,
  spawn: SpawnFn,
  rt: RuntimeAccess,
) => () => void;
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> { return (yield impl) as T; }

export type Yieldable = number | undefined | Animator<any> | Yieldable[] | SuspendFn<any>;
export type Animator<R = void> = Generator<Yieldable, R, number>;
export type PayloadOf<Y> = Y extends Animator<infer R> ? R : Y extends SuspendFn<infer R> ? R : void;

const isGen = (v: any): v is Animator<any> =>
  v != null && typeof v === "object" && typeof v.next === "function";

class Active {
  wakeAt = 0;             // 0 ready · >0 sleep target (engine.clock domain) · Infinity parked
  dispose: (() => void) | null = null;
  onDone: ((v: unknown) => void) | null = null;
  kids: Active[] | null = null;
  done = false;
  busy = false;
  pendingReturn = false;
  // null = unscaled (fast path); thunk returns the current effective scale.
  effFn: (() => number) | null = null;
  constructor(readonly gen: Animator<any>, readonly par: Active | null) {}
}

class Ticker {
  alive = true;
  t = 0;
  // null = unscaled (fast path)
  effFn: (() => number) | null = null;
  constructor(readonly cb: (dt: number, t: number) => void) {}
}

export class Anim implements RuntimeAccess {
  private actives: Active[] = [];
  private tickers: Ticker[] = [];
  private deadSeen = 0;
  // Set during a SuspendFn `impl(...)` call so onFrame inherits the host's scale.
  private subscribingHost: Active | null = null;
  clock = 0;

  onFrame(cb: (dt: number, t: number) => void): () => void {
    const t = new Ticker(cb);
    if (this.subscribingHost) t.effFn = this.subscribingHost.effFn;
    this.tickers.push(t);
    return () => { t.alive = false; };
  }

  run(g: Animator<any> | (() => Animator<any>)): () => void {
    const a = this.spawn(typeof g === "function" ? g() : g, null);
    return () => this.cancel(a);
  }

  stop(): void {
    for (const a of this.actives.slice()) this.cancel(a);
    this.actives.length = 0;
    this.tickers.length = 0;
    this.clock = 0;
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    // Tickers — hot path. Fast lane: effFn === null → no scaling math.
    const ts = this.tickers;
    if (ts.length > 0) {
      let tw = 0;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (!t.alive) continue;
        const sdt = t.effFn === null ? dt : dt * t.effFn();
        t.t += sdt;
        t.cb(sdt, t.t);
        if (!t.alive) continue;
        if (i !== tw) ts[tw] = t;
        tw++;
      }
      ts.length = tw;
    }
    // Actives. Fast lane: identical to mini.
    const arr = this.actives;
    const len = arr.length;
    const deadBefore = this.deadSeen;
    const cn = this.clock;
    for (let i = 0; i < len; i++) {
      const a = arr[i];
      if (!a.done && a.wakeAt <= cn) {
        a.wakeAt = 0;
        // dt resume is scaled only for scaled actives.
        this.advance(a, a.effFn === null ? dt : dt * a.effFn());
      }
    }
    if (this.deadSeen !== deadBefore) {
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (!a.done) { if (i !== w) arr[w] = a; w++; }
      }
      arr.length = w;
    }
  }

  private spawn(
    g: Animator<any>,
    par: Active | null,
    onDone?: (v: unknown) => void,
    scale?: number | (() => number),
  ): Active {
    const a = new Active(g, par);
    if (onDone) a.onDone = onDone;
    // Inherit parent's effFn; if scale provided, compose own × parent.
    if (scale !== undefined && scale !== 1) {
      const parentEff = par?.effFn;
      a.effFn = typeof scale === "number"
        ? (parentEff ? () => scale * parentEff() : () => scale)
        : (parentEff ? () => (scale as () => number)() * parentEff() : scale as () => number);
    } else if (par?.effFn) {
      a.effFn = par.effFn;
    }
    if (par) (par.kids ??= []).push(a);
    this.actives.push(a);
    this.advance(a, undefined);
    return a;
  }

  private cancel(a: Active): void {
    if (a.done) return;
    a.done = true;
    this.deadSeen++;
    const d = a.dispose; a.dispose = null;
    if (d) d();
    if (a.par?.kids) {
      const i = a.par.kids.indexOf(a);
      if (i >= 0) a.par.kids.splice(i, 1);
    }
    if (a.kids) {
      const cs = a.kids; a.kids = null;
      for (let i = 0; i < cs.length; i++) if (!cs[i].done) this.cancel(cs[i]);
    }
    if (a.busy) { a.pendingReturn = true; return; }
    try { a.gen.return(undefined); } catch {}
  }

  private advance(a: Active, resume: unknown): void {
    a.busy = true;
    try {
      let r = a.gen.next(resume as any);
      while (!r.done) {
        if (a.done) return;
        const v = r.value;
        if (v === undefined) return;
        if (typeof v === "number") {
          if (v > 0) {
            // Sleep target: engine clock + duration. Scaled scopes divide
            // by their current eff so the wait is `v` scaled-seconds long.
            const dur = a.effFn === null ? v : v / a.effFn();
            a.wakeAt = this.clock + dur;
            return;
          }
          r = a.gen.next(0); continue;
        }
        if (typeof v === "function") return this.subscribe(a, v as SuspendFn<any>);
        return this.spawnKids(a, Array.isArray(v) ? v : [v]);
      }
      if (a.done) return;
      a.done = true;
      this.deadSeen++;
      if (a.par?.kids) {
        const i = a.par.kids.indexOf(a);
        if (i >= 0) a.par.kids.splice(i, 1);
      }
      const cb = a.onDone; a.onDone = null;
      if (cb) cb(r.value);
    } catch (e) {
      console.error("minim:", e);
      if (!a.done) { a.done = true; this.deadSeen++; }
    } finally {
      a.busy = false;
      if (a.pendingReturn) { a.pendingReturn = false; try { a.gen.return(undefined); } catch {} }
    }
  }

  private subscribe(a: Active, impl: SuspendFn<any>): void {
    let resumed = false;
    const wake = (val?: unknown): void => {
      if (resumed || a.done) return;
      resumed = true;
      const d = a.dispose; a.dispose = null;
      a.wakeAt = 0;
      if (d) d();
      this.advance(a, val);
    };
    const spawn: SpawnFn = (g, oc, sc) => {
      const c = this.spawn(g, a, oc as any, sc);
      return () => this.cancel(c);
    };
    const prev = this.subscribingHost;
    this.subscribingHost = a;
    let dispose: () => void;
    try { dispose = impl(wake, spawn, this); }
    finally { this.subscribingHost = prev; }
    if (resumed || a.done) { try { dispose(); } catch {} }
    else { a.wakeAt = Infinity; a.dispose = dispose; }
  }

  private spawnKids(a: Active, kids: Yieldable[]): void {
    if (kids.length === 0) return this.advance(a, undefined);
    let left = kids.length;
    a.wakeAt = Infinity;
    const onChild = (): void => {
      if (--left === 0 && a.wakeAt === Infinity && !a.done) {
        a.wakeAt = 0;
        this.advance(a, undefined);
      }
    };
    for (let j = 0; j < kids.length; j++) {
      if (a.done) return;
      const k = kids[j];
      this.spawn(isGen(k) ? k : (function* () { yield k as any; })(), a, onChild);
    }
  }
}

// ── drive — uses onFrame to bypass per-frame generator overhead ────

export function drive(step: (dt: number, t: number) => boolean | void): Animator {
  return suspend<void>((wake, _spawn, rt) =>
    rt.onFrame((dt, t) => { if (step(dt, t) === false) wake(); })
  );
}

// ── attachRaf — RAF lives outside the engine ───────────────────────

export function attachRaf(anim: Anim): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  let rafId = 0, last = 0;
  const tick = (now: number): void => {
    rafId = requestAnimationFrame(tick);
    const dt = last === 0 ? 0 : Math.min(now - last, FRAME_CAP_MS) / 1000;
    last = now;
    anim.step(dt);
  };
  rafId = requestAnimationFrame(tick);
  return () => { if (rafId) cancelAnimationFrame(rafId); rafId = 0; last = 0; };
}
