// Generator-driven animation runner. Yield contract:
//   undefined        → wait one frame, receive `dt`.
//   number           → pause N seconds; ≤0 is a tail-call (same frame).
//   Animator         → spawn as child, wait for completion.
//   Yieldable[]      → spawn N children in parallel, wait for all.
//   Awaitable        → suspend until `wake` fires (zero-latency).
//
// Generators always resume with a `number` (`dt` for frame yields, `0`
// otherwise) — payload-less wakes. Side-channel data lives in signals.
//
// Synchronous scheduler: a single RAF loop drives `step(dt)`. `step` is
// also public for headless / test harnesses.

/** Subscribe-style "wait for an external thing." `subscribe` registers
 *  the wake callback and returns a disposer. Sync-resolve is allowed
 *  (subscribe may call wake before returning) — handy for composers
 *  whose children may complete during setup. */
export type Awaitable = (wake: () => void) => () => void;

export type Yieldable = number | undefined | Animator | Yieldable[] | Awaitable;
export type Animator = Generator<Yieldable, void, number>;

/** Per-active state. At most one of `wakeAt`/`childrenLeft`/`awaitDispose`
 *  is set while suspended; otherwise the active is "ready next frame."
 *  `pendingReturn` defers `.return()` if the gen is on the call stack. */
interface Active {
  gen: Animator;
  wakeAt?: number;
  childrenLeft?: number;
  awaitDispose?: () => void;
  parent?: Active;
  alive: boolean;
  pendingReturn?: boolean;
}

const isGen = (v: unknown): v is Animator =>
  typeof v === "object" && v !== null && Symbol.iterator in v;

export class Anim {
  private active: Active[] = [];
  private scopes = new Set<Anim>();
  private rafId = 0;
  private clock = 0;
  private lastFrame = 0;
  /** Every Active currently on the JS call stack — re-entrant `advance`
   *  is routine (Awaitable wakes, child completions). `cancel()` checks
   *  this set to decide whether to defer `.return()`. */
  private advancing = new Set<Active>();

  // ── Public API ──────────────────────────────────────────────────────

  /** Run a generator forever, restarting on completion. */
  loop(factory: () => Animator): () => void {
    const wrapped = (function* (): Animator {
      while (true) yield* factory();
    })();
    const a = this.spawn(wrapped);
    return () => this.cancel(a);
  }

  /** Run a generator once. Accepts a factory or an already-constructed
   *  Animator — the latter is convenient when something returns one
   *  (`anim.run(speed(clock, 1))`). Returns a disposer. */
  run(arg: Animator | (() => Animator)): () => void {
    const gen = typeof arg === "function" ? arg() : arg;
    const a = this.spawn(gen);
    return () => this.cancel(a);
  }

  /** Spawn N children, resume on first to complete, cancel the losers. */
  *race(...children: Animator[]): Animator {
    const self = this;
    yield (wake: () => void) => {
      // Defer wake until all children are spawned, so the disposer's
      // cancel sweep can reach every child (including any that finished
      // synchronously during setup).
      let setupDone = false;
      let pending = false;
      const safeWake = () => {
        if (setupDone) wake();
        else pending = true;
      };
      const cancels = children.map((c) =>
        self.run(function* () {
          yield* c;
          safeWake();
        }),
      );
      setupDone = true;
      if (pending) wake();
      return () => {
        for (const c of cancels) c();
      };
    };
  }

  /** Child Anim scoped to this one — stopped when the parent stops. */
  scope(): Anim {
    const child = new Anim();
    this.scopes.add(child);
    return child;
  }

  /** Cancel everything. Safe from inside a running generator; cascades
   *  to scopes. The Anim is reusable after return. */
  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.lastFrame = 0;
    this.clock = 0;
    for (const a of this.active.slice()) this.cancel(a);
    this.scopes.forEach((s) => s.stop());
    this.scopes.clear();
  }

  /** Advance the runtime by an explicit dt. Production calls this from
   *  RAF; tests call it directly. */
  step(dt: number): void {
    this.clock += dt;
    // Length-snapshot iteration: children spawned during the loop are
    // deferred to the next tick (matches RAF callback semantics).
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const a = this.active[i];
      if (!a.alive) continue;
      if (a.wakeAt !== undefined) {
        if (this.clock >= a.wakeAt) {
          a.wakeAt = undefined;
          this.advance(a, 0);
        }
      } else if (a.childrenLeft !== undefined || a.awaitDispose !== undefined) {
        // Suspended on children or an Awaitable; resume is callback-driven.
      } else {
        this.advance(a, dt);
      }
    }
    // Compact dead entries in place; entries pushed past `len` survive.
    let w = 0;
    for (let r = 0; r < this.active.length; r++) {
      const a = this.active[r];
      if (a.alive) {
        if (r !== w) this.active[w] = a;
        w++;
      }
    }
    this.active.length = w;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private spawn(gen: Animator, parent?: Active): Active {
    const a: Active = { gen, parent, alive: true };
    this.active.push(a);
    this.advance(a, 0);
    this.kick();
    return a;
  }

  /** Mark dead, dispose any pending Awaitable, cascade to live children,
   *  then `.return()` (or defer if on the stack). Idempotent. */
  private cancel(a: Active): void {
    if (!a.alive) return;
    a.alive = false;
    if (a.awaitDispose) {
      const d = a.awaitDispose;
      a.awaitDispose = undefined;
      d();
    }
    // Cascade: snapshot length so freshly-spawned entries (different
    // parent anyway) aren't re-scanned.
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const child = this.active[i];
      if (child.parent === a && child.alive) this.cancel(child);
    }
    if (this.advancing.has(a)) {
      a.pendingReturn = true;
      return;
    }
    a.gen.return();
  }

  private kick(): void {
    if (this.rafId !== 0 || this.active.length === 0) return;
    // Reset after idle so the next RAF reports dt=0 — pauses don't
    // accumulate logical time.
    if (performance.now() - this.lastFrame > 32) this.lastFrame = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (rafNow: number): void => {
    this.rafId = 0;
    // First frame after idle: dt=0. Subsequent frames clamp at 32ms.
    const dt =
      this.lastFrame === 0 ? 0 : Math.min(rafNow - this.lastFrame, 32) / 1000;
    this.lastFrame = rafNow;
    try {
      this.step(dt);
    } finally {
      // Reschedule even on error — keep the runtime alive.
      this.kick();
    }
  };

  /** Subscribe to an Awaitable; resume `a` when wake fires. Two paths:
   *  async (subscribe returns, gen suspends, wake later resumes); sync
   *  (subscribe calls wake inline — gen advances re-entrantly, dispose
   *  is called once subscribe returns). */
  private suspend(a: Active, awaitable: Awaitable): void {
    let resumed = false;
    let dispose: (() => void) | undefined;
    const wake = () => {
      if (resumed || !a.alive) return;
      resumed = true;
      if (dispose) {
        if (a.awaitDispose === dispose) a.awaitDispose = undefined;
        dispose();
      }
      this.advance(a, 0);
    };
    dispose = awaitable(wake);
    if (resumed) {
      // Sync wake: dispose wasn't bound when wake fired. Run it now;
      // a recursive yield may have installed its own awaitDispose, so
      // don't touch that slot.
      dispose();
      return;
    }
    a.awaitDispose = dispose;
  }

  private advance(a: Active, dt: number): void {
    this.advancing.add(a);
    try {
      let result = a.gen.next(dt);
      while (!result.done) {
        if (!a.alive) return;
        const v = result.value;
        if (typeof v === "number") {
          if (v > 0) {
            a.wakeAt = this.clock + v;
            return;
          }
          // ≤0: tail-call — advance without consuming a frame.
          result = a.gen.next(0);
        } else if (v === undefined) {
          return;
        } else if (Array.isArray(v)) {
          if (v.length === 0) {
            result = a.gen.next(0);
            continue;
          }
          a.childrenLeft = v.length;
          for (const item of v) {
            if (!a.alive) return;
            this.spawn(isGen(item) ? item : wrapItem(item), a);
          }
          return;
        } else if (typeof v === "function") {
          this.suspend(a, v as Awaitable);
          return;
        } else {
          a.childrenLeft = 1;
          this.spawn(v, a);
          return;
        }
      }
      this.complete(a);
    } catch (e) {
      // User-code error: log, complete (notifies parent), keep runtime alive.
      console.error("minim: animator threw", e);
      this.complete(a);
    } finally {
      this.advancing.delete(a);
      if (a.pendingReturn) {
        a.pendingReturn = false;
        a.gen.return();
      }
    }
  }

  private complete(a: Active): void {
    if (!a.alive) return;
    a.alive = false;
    if (a.awaitDispose) {
      const d = a.awaitDispose;
      a.awaitDispose = undefined;
      d();
    }
    const p = a.parent;
    if (!p || !p.alive || p.childrenLeft === undefined) return;
    p.childrenLeft -= 1;
    if (p.childrenLeft === 0) {
      p.childrenLeft = undefined;
      this.advance(p, 0);
    }
  }
}

/** Wrap a non-generator parallel-array item so it goes through `spawn`. */
function* wrapItem(v: number | undefined | Yieldable[] | Awaitable): Animator {
  yield v;
}
