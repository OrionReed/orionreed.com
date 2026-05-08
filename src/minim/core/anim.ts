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

import { signal, type ReadonlySignal, type Signal } from "./signal";

/** Convention: a generator may carry a `__minimTag` string property to
 *  identify it in traces. The runtime peeks this at spawn time and
 *  copies it to `Span.tag`. Set by `tag` / `tagAll` (in `../trace/tag`)
 *  but the runtime doesn't import either — string convention is enough.
 *  Exported as a constant so consumers writing custom helpers stay in
 *  sync. */
export const TAG_KEY = "__minimTag" as const;

/** Subscribe-style "wait for an external thing." `subscribe` registers
 *  the wake callback and returns a disposer. Sync-resolve is allowed
 *  (subscribe may call wake before returning) — handy for composers
 *  whose children may complete during setup. */
export type Awaitable = (wake: () => void) => () => void;

export type Yieldable = number | undefined | Animator | Yieldable[] | Awaitable;
export type Animator = Generator<Yieldable, void, number>;

/** Per-active state. At most one of `wakeAt`/`childrenLeft`/`awaitDispose`
 *  is set while suspended; otherwise the active is "ready next frame."
 *  `onStack` marks the active as being inside `advance` (re-entrant
 *  routinely); `pendingReturn` defers `.return()` until it unwinds. */
interface Active {
  gen: Animator;
  wakeAt?: number;
  childrenLeft?: number;
  awaitDispose?: () => void;
  parent?: Active;
  alive: boolean;
  onStack?: boolean;
  pendingReturn?: boolean;
}

/** A single generator's lifecycle as flat data. `completedAt` is set
 *  on natural completion *and* on cancel — consumers reading still-open
 *  spans see `undefined`. Spawn order matches insertion order in
 *  `Trace.spans`; `parentId` walks the spawn tree. `tag` is set at
 *  spawn time from the generator's `__minimTag` slot if present
 *  (see `../trace/tag`). */
export type Span = {
  readonly id: number;
  readonly parentId?: number;
  readonly spawnedAt: number;
  readonly tag?: string;
  completedAt?: number;
};

/** Live recording of generator lifecycle, started by `Anim.trace()`.
 *  `spans` mutates in place — new entries on spawn, `completedAt` set
 *  on completion/cancel. `version` bumps on every structural change
 *  (spawn / complete / cancel) so consumers can subscribe natively
 *  instead of polling. Purely data; views (tree, gantt, equality)
 *  live outside `Anim`. */
export type Trace = {
  readonly spans: readonly Span[];
  /** Bumps on each spawn / complete / cancel. Sparse, event-paced —
   *  not per-frame. Use a separate clock for per-frame needs. */
  readonly version: ReadonlySignal<number>;
  /** Wall-clock span of the trace: `max(completedAt ?? clock) − min(spawnedAt)`. */
  duration(): number;
  /** Stop collecting; the existing `spans` array is yours to keep. */
  stop(): void;
};

const isGen = (v: unknown): v is Animator =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Animator).next === "function";

export class Anim {
  private active: Active[] = [];
  private scopes = new Set<Anim>();
  private rafId = 0;
  private clock = 0;
  private lastFrame = 0;
  /** Trace recording state — undefined unless `trace()` was called.
   *  Hot-path overhead: one truthiness check per spawn / complete /
   *  cancel. `byActive` resolves an Active back to its Span on end;
   *  `version` is the public reactive change-counter exposed via
   *  `Trace.version`. */
  private _trace?: {
    spans: Span[];
    byActive: Map<Active, Span>;
    nextId: number;
    version: Signal<number>;
  };

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

  /** Begin recording lifecycle of every generator spawned from now on
   *  (already-running generators are not retroactively included). The
   *  returned `spans` array fills live as `Active`s spawn and complete;
   *  `completedAt` is set on natural completion and on cancel.
   *
   *  Calling `trace()` again replaces the recording — the previous
   *  `Trace` keeps its `spans` array (for inspection) but receives no
   *  further updates. */
  trace(): Trace {
    const spans: Span[] = [];
    const byActive = new Map<Active, Span>();
    const version = signal(0);
    this._trace = { spans, byActive, nextId: 0, version };
    const self = this;
    const ours = this._trace;
    return {
      spans,
      version,
      duration() {
        if (spans.length === 0) return 0;
        let min = Infinity;
        let max = 0;
        for (const s of spans) {
          if (s.spawnedAt < min) min = s.spawnedAt;
          const end = s.completedAt ?? self.clock;
          if (end > max) max = end;
        }
        return max - min;
      },
      stop() {
        if (self._trace === ours) self._trace = undefined;
      },
    };
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
      } else if (a.childrenLeft === undefined && a.awaitDispose === undefined) {
        this.advance(a, dt);
      }
      // else: suspended on children/Awaitable; resume is callback-driven.
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
    if (this._trace) {
      const tag = (gen as { [TAG_KEY]?: unknown })[TAG_KEY];
      const span: Span = {
        id: ++this._trace.nextId,
        parentId: parent ? this._trace.byActive.get(parent)?.id : undefined,
        spawnedAt: this.clock,
        tag: typeof tag === "string" ? tag : undefined,
      };
      this._trace.spans.push(span);
      this._trace.byActive.set(a, span);
      this._trace.version.value++;
    }
    this.advance(a, 0);
    this.kick();
    return a;
  }

  /** Stamp `completedAt` on the trace span (if any) for `a` and bump
   *  the trace's version signal. Called from both natural completion
   *  and cancel paths. */
  private markEnd(a: Active): void {
    if (!this._trace) return;
    const span = this._trace.byActive.get(a);
    if (span && span.completedAt === undefined) {
      span.completedAt = this.clock;
      this._trace.version.value++;
    }
  }

  /** Mark dead, dispose any pending Awaitable, cascade to live children,
   *  then `.return()` (or defer if on the stack). Idempotent. */
  private cancel(a: Active): void {
    if (!a.alive) return;
    a.alive = false;
    this.markEnd(a);
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

  /** Subscribe to an Awaitable; resume `a` when wake fires. If subscribe
   *  calls wake inline (sync-resolve), the gen advances re-entrantly and
   *  the disposer runs after subscribe returns — a recursive yield may
   *  have installed its own `awaitDispose`, so we don't touch that slot. */
  private suspend(a: Active, awaitable: Awaitable): void {
    let resumed = false;
    let dispose: (() => void) | undefined;
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
    dispose = awaitable(wake);
    if (resumed) dispose();
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
          for (let j = 0; j < v.length; j++) {
            if (!a.alive) return;
            const item = v[j];
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
    this.markEnd(a);
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
