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

/** Spawn-as-child capability handed to awaitables. The spawned generator
 *  is parented to the suspended host, so cascade-cancel reaches it; the
 *  optional `onComplete` fires on natural completion (not on cancel) and
 *  is how `race`/`all`/`single` learn that a child finished. The returned
 *  disposer cancels the spawned child. Only valid during the awaitable's
 *  initial subscribe call — calling later throws. */
export type SpawnFn = (gen: Animator, onComplete?: () => void) => () => void;

/** Subscribe-style "wait for an external thing." `subscribe` registers
 *  the wake callback (and may spawn host-parented children via `spawn`)
 *  and returns a disposer. Sync-resolve is allowed (subscribe may call
 *  wake before returning) — handy for composers whose children may
 *  complete during setup.
 *
 *  Note: `spawn` is positionally required at the type level, but
 *  function-arity subtyping means simple subscribers can declare just
 *  `(wake) => dispose` and remain assignable. Combinators that
 *  orchestrate generators (`race`, `until`, `all`) declare both args
 *  and use them directly — no casts needed. */
export type Awaitable = (wake: () => void, spawn: SpawnFn) => () => void;

export type Yieldable = number | undefined | Animator | Yieldable[] | Awaitable;
export type Animator = Generator<Yieldable, void, number>;

/** Lifecycle listeners passed to `Anim.observe`. Fields are optional so
 *  consumers (trace, debug overlays, perf counters) only opt in to the
 *  events they need. The runtime short-circuits when no listeners are
 *  registered, so observation is free when unused. */
export type ObserveListeners = {
  spawn?: (
    id: number,
    parentId: number | undefined,
    clock: number,
    gen: Animator,
  ) => void;
  complete?: (id: number, clock: number) => void;
  cancel?: (id: number, clock: number) => void;
};

/** Per-active state. At most one of `wakeAt`/`awaitDispose` is set while
 *  suspended; otherwise the active is "ready next frame." `onComplete`
 *  is set by parents (via `spawn` or `ctx.spawn`) and fires on natural
 *  completion — used by `all`/`single`/`race` to learn child outcomes.
 *  `onStack` marks the active as being inside `advance` (re-entrant
 *  routinely); `pendingReturn` defers `.return()` until it unwinds.
 *  `observeId` is set lazily, only when an observer is registered at
 *  spawn time.
 *
 *  All fields are assigned at construction (see `spawn()`) — `undefined`
 *  for the not-yet-set ones — so the V8 hidden class stays monomorphic
 *  across the active's lifetime. */
interface Active {
  gen: Animator;
  wakeAt: number | undefined;
  awaitDispose: (() => void) | undefined;
  onComplete: (() => void) | undefined;
  parent: Active | undefined;
  alive: boolean;
  onStack: boolean;
  pendingReturn: boolean;
  observeId: number | undefined;
}

const isGen = (v: unknown): v is Animator =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Animator).next === "function";

export class Anim {
  private active: Active[] = [];
  private scopes = new Set<Anim>();
  private rafId = 0;
  private _clock = 0;
  private lastFrame = 0;
  /** Logical clock — total seconds advanced via `step(dt)`. Reset by
   *  `stop()`. Public read-only so observers (trace, debug overlays)
   *  can timestamp in-flight events without going through a per-frame
   *  signal. For a reactive per-frame clock signal, use `clock(anim)`
   *  from `motion/clocks.ts`. */
  get clock(): number {
    return this._clock;
  }
  /** Registered lifecycle observers. Empty by default; populated via
   *  `observe()`. Hot-path overhead is one `size > 0` check per spawn /
   *  complete / cancel; when no observers, no IDs are allocated and no
   *  callbacks fire. Multiple observers fan out — useful for trace +
   *  debug overlay + perf counters all watching the same Anim. */
  private listeners = new Set<ObserveListeners>();
  private nextActiveId = 0;

  // ── Public API ──────────────────────────────────────────────────────

  /** Run a generator forever, restarting on completion. */
  loop(factory: () => Animator): () => void {
    return this.run(function* () {
      while (true) yield* factory();
    });
  }

  /** Run a generator once. Accepts a factory or an already-constructed
   *  Animator — the latter is convenient when something returns one
   *  (`anim.run(speed(clock, 1))`). Returns a disposer. */
  run(arg: Animator | (() => Animator)): () => void {
    const gen = typeof arg === "function" ? arg() : arg;
    const a = this.spawn(gen);
    return () => this.cancel(a);
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
    this._clock = 0;
    for (const a of this.active.slice()) this.cancel(a);
    this.scopes.forEach((s) => s.stop());
    this.scopes.clear();
  }

  /** Subscribe to lifecycle events (spawn / complete / cancel). Only
   *  fields present in `listeners` fire; the rest are skipped. Returns
   *  a disposer that removes this observer.
   *
   *  Multiple observers may register simultaneously — they all fire on
   *  every event. Already-running generators are not retroactively
   *  included; only spawns from this point on get IDs and fire events.
   *  The event payloads are primitives (id, parentId, clock) plus the
   *  spawned `gen` reference so consumers can attach metadata via
   *  WeakMap (used by `trace/tag.ts`).
   *
   *  Zero overhead when no observers: spawn / complete / cancel each
   *  gate their work behind a single `size > 0` check on the listener
   *  set. */
  observe(listeners: ObserveListeners): () => void {
    this.listeners.add(listeners);
    return () => {
      this.listeners.delete(listeners);
    };
  }

  /** Advance the runtime by an explicit dt. Production calls this from
   *  RAF; tests call it directly. */
  step(dt: number): void {
    this._clock += dt;
    // Length-snapshot iteration: children spawned during the loop are
    // deferred to the next tick (matches RAF callback semantics).
    const len = this.active.length;
    for (let i = 0; i < len; i++) {
      const a = this.active[i];
      if (!a.alive) continue;
      if (a.wakeAt !== undefined) {
        if (this._clock >= a.wakeAt) {
          a.wakeAt = undefined;
          this.advance(a, 0);
        }
      } else if (a.awaitDispose === undefined) {
        this.advance(a, dt);
      }
      // else: suspended (on awaitable or on spawned children — both
      // mark via `awaitDispose`); resume is callback-driven.
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

  /** Spawn a generator. `parent` parents it for cascade-cancel and the
   *  observe-event parentId; `onComplete` is called on natural
   *  completion (used by `advance` for `yield gen` / `yield [...]` and
   *  by awaitable `spawn` for race/all/single). */
  private spawn(
    gen: Animator,
    parent?: Active,
    onComplete?: () => void,
  ): Active {
    // All fields assigned at the literal so V8 keeps a monomorphic
    // hidden class for Actives across the runtime.
    const a: Active = {
      gen,
      wakeAt: undefined,
      awaitDispose: undefined,
      onComplete,
      parent,
      alive: true,
      onStack: false,
      pendingReturn: false,
      observeId: undefined,
    };
    this.active.push(a);
    if (this.listeners.size > 0) {
      a.observeId = ++this.nextActiveId;
      for (const l of this.listeners) {
        l.spawn?.(a.observeId, parent?.observeId, this._clock, gen);
      }
    }
    this.advance(a, 0);
    this.kick();
    return a;
  }

  /** Mark dead, dispose any pending Awaitable, cascade to live children,
   *  then `.return()` (or defer if on the stack). Idempotent. Note:
   *  `onComplete` is *not* fired on cancel — only natural completion
   *  reports back to parent awaitables. */
  private cancel(a: Active): void {
    if (!a.alive) return;
    a.alive = false;
    if (this.listeners.size > 0 && a.observeId !== undefined) {
      for (const l of this.listeners) l.cancel?.(a.observeId, this._clock);
    }
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
    if (a.onStack) {
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

  /** Subscribe to an Awaitable; resume `a` when wake fires. Provides the
   *  awaitable with `spawn` parented to `a` (only valid during the
   *  initial subscribe — calling `spawn` after the subscribe returns
   *  throws, since the host might be cancelled by then and the contract
   *  would silently break).
   *
   *  If subscribe calls wake inline (sync-resolve), the gen advances
   *  re-entrantly and the disposer runs after subscribe returns — a
   *  recursive yield may have installed its own `awaitDispose`, so we
   *  don't touch that slot. */
  private suspend(a: Active, awaitable: Awaitable): void {
    let resumed = false;
    let dispose: (() => void) | undefined;
    let setupActive = true;
    const wake = () => {
      if (resumed || !a.alive) return;
      resumed = true;
      const d = dispose;
      if (d) {
        if (a.awaitDispose === d) a.awaitDispose = undefined;
        d();
      }
      this.advance(a, 0);
    };
    const spawn: SpawnFn = (gen, onComplete) => {
      if (!setupActive) {
        throw new Error("minim: spawn() valid only during awaitable setup");
      }
      const child = this.spawn(gen, a, onComplete);
      return () => this.cancel(child);
    };
    dispose = awaitable(wake, spawn);
    setupActive = false;
    // If the host died during setup (rare — e.g. a sync-spawned child
    // emitted an event that cancelled us), dispose immediately rather
    // than parking the disposer on a dead active.
    if (resumed || !a.alive) dispose();
    else a.awaitDispose = dispose;
  }

  private advance(a: Active, dt: number): void {
    a.onStack = true;
    try {
      let result = a.gen.next(dt);
      while (!result.done) {
        if (!a.alive) return;
        const v = result.value;
        if (typeof v === "number") {
          if (v > 0) {
            a.wakeAt = this._clock + v;
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
          // Counter lives in this closure; on each child's natural
          // completion, decrement and resume the parent when zero.
          // Install a no-op disposer to mark "suspended on children" —
          // step() sees `awaitDispose` present and skips ticking. Cancel
          // cascade still reaches children via parent==a.
          let left = v.length;
          a.awaitDispose = noop;
          const onChild = () => {
            if (--left === 0 && a.alive) {
              a.awaitDispose = undefined;
              this.advance(a, 0);
            }
          };
          for (let j = 0; j < v.length; j++) {
            if (!a.alive) return;
            const item = v[j];
            this.spawn(isGen(item) ? item : wrapItem(item), a, onChild);
          }
          return;
        } else if (typeof v === "function") {
          this.suspend(a, v as Awaitable);
          return;
        } else {
          // Single child generator. On its completion, resume parent.
          a.awaitDispose = noop;
          this.spawn(v, a, () => {
            if (a.alive) {
              a.awaitDispose = undefined;
              this.advance(a, 0);
            }
          });
          return;
        }
      }
      this.complete(a);
    } catch (e) {
      // User-code error: log, complete (notifies parent), keep runtime alive.
      console.error("minim: animator threw", e);
      this.complete(a);
    } finally {
      a.onStack = false;
      if (a.pendingReturn) {
        a.pendingReturn = false;
        a.gen.return();
      }
    }
  }

  private complete(a: Active): void {
    if (!a.alive) return;
    a.alive = false;
    if (this.listeners.size > 0 && a.observeId !== undefined) {
      for (const l of this.listeners) l.complete?.(a.observeId, this._clock);
    }
    if (a.awaitDispose) {
      const d = a.awaitDispose;
      a.awaitDispose = undefined;
      d();
    }
    if (a.onComplete) {
      const cb = a.onComplete;
      a.onComplete = undefined;
      cb();
    }
  }
}

/** Stable no-op disposer used when an Active is suspended on its own
 *  spawned children (yield gen / yield array). Cancel cascade still
 *  reaches the children via `parent === a`; the disposer just marks
 *  "not ready to tick" for `step()`. */
const noop = (): void => {};

/** Wrap a non-generator parallel-array item so it goes through `spawn`. */
function* wrapItem(v: number | undefined | Yieldable[] | Awaitable): Animator {
  yield v;
}
