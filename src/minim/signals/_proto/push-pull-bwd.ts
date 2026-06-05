// Push-pull backward prototype — isolated from the shipped engine.
//
// Today's engine resolves a single-parent lens write EAGERLY: `view.value =
// x` walks to the source immediately, applying `put` at each hop. Inside a
// batch that means (a) one full walk per write (no coalescing of repeated
// writes to the same view), and (b) a `settled` special-case so the walk's
// internal no-op checks don't commit a source's pending value and turn a
// net-zero revert into a spurious change.
//
// Forward is push-pull: a write PUSHES invalidation cheaply (mark dirty,
// schedule effects) and the value is PULLED lazily on read. This prototype
// gives BACKWARD the same shape:
//
//   * push  — `view.value = x` in a batch stashes `x` as the view's pending
//             backward target and enqueues the view (O(1)). No `put`, no
//             walk. Re-writing the same view overwrites its target →
//             last-write-wins for free.
//   * pull  — the put-chain runs only when a source value is OBSERVED. Any
//             read during the batch first DRAINS the pending backward queue
//             (resolve each view → its source, once), then reads forward.
//             `flush` drains whatever is left, then runs effects.
//
// What this buys, and why it subsumes the two patches:
//   * write-then-read  — a read drains first, so the just-written view (and
//                        any sibling view of the same source) reads back the
//                        resolved value. No eager walk needed.
//   * net-zero revert  — `v=1; v=0` overwrites the target to 0 BEFORE any
//                        resolution; the source is written once, with 0, so
//                        `writeSource` sees no change and fires nothing. No
//                        `settled` needed: nothing ever staged the
//                        intermediate, because coalescing happens in the
//                        QUEUE, above the source.
//   * coalescing       — k writes to a view with no interleaved read cost
//                        ONE put-chain at drain, not k.
//
// The cost: a read during a batch drains the whole queue (a source can't
// cheaply find its own pending-writer views — the structural asymmetry
// noted in review). The drain is cursor-amortized (each entry resolved
// once), so interleaved read/write is O(total writes), not O(reads×writes)
// — the same amortization forward's `checkDirty` already relies on.

// ─── Instrumentation ────────────────────────────────────────────────

interface Counts {
  put: number; // backward put-chain hops
  fwd: number; // forward projections
  sourceWrites: number; // writeSource calls that actually CHANGED a source
  effectRuns: number; // effect body invocations (re-runs that over-fire)
}
const counts: Counts = { put: 0, fwd: 0, sourceWrites: 0, effectRuns: 0 };
const resetCounts = (): void => {
  counts.put = counts.fwd = counts.sourceWrites = counts.effectRuns = 0;
};

// ─── Engine globals ──────────────────────────────────────────────────

let batchDepth = 0;
const bwdQueue: Lens<unknown>[] = [];
let drainCursor = 0;
const pendingEffects = new Set<Effect>();
let activeEffect: Effect | undefined;

const NONE = Symbol("none");

/** Resolve any not-yet-drained backward writes (the lazy pull). Reads call
 *  this before observing a source; `flush` calls it before effects. */
function drainBwd(): void {
  while (drainCursor < bwdQueue.length) {
    const lens = bwdQueue[drainCursor++]!;
    lens.queued = false;
    lens.resolve();
  }
}

function flush(): void {
  drainBwd();
  bwdQueue.length = 0;
  drainCursor = 0;
  const fire = [...pendingEffects];
  pendingEffects.clear();
  for (const e of fire) e.run();
}

function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}

// ─── Source ──────────────────────────────────────────────────────────

class Source<T> {
  current: T;
  subs = new Set<Effect>();
  constructor(v: T) {
    this.current = v;
  }
  read(): T {
    if (drainCursor < bwdQueue.length) drainBwd();
    if (activeEffect !== undefined) this.subs.add(activeEffect);
    return this.current;
  }
  /** The single place truth mutates. Fires subscribers only on a real
   *  change — net-zero reverts arrive here already coalesced to a no-op. */
  writeSource(x: T): void {
    if (Object.is(x, this.current)) return;
    counts.sourceWrites++;
    this.current = x;
    for (const e of this.subs) pendingEffects.add(e);
  }
}

// ─── 1→1 lens ────────────────────────────────────────────────────────

type AnyNode = Source<unknown> | Lens<unknown>;

class Lens<T> {
  pendingTarget: T | typeof NONE = NONE;
  queued = false;
  constructor(
    readonly parent: AnyNode,
    private readonly fwd: (p: never) => T,
    private readonly put: (target: T, current?: never) => unknown,
    private readonly readsSource: boolean,
  ) {}

  read(): T {
    if (drainCursor < bwdQueue.length) drainBwd();
    counts.fwd++;
    return this.fwd((this.parent as { read(): unknown }).read() as never);
  }

  set value(x: T) {
    if (batchDepth > 0) {
      // PUSH: stash target, enqueue once. Last write wins (overwrite).
      this.pendingTarget = x;
      if (!this.queued) {
        this.queued = true;
        bwdQueue.push(this as Lens<unknown>);
      }
      return;
    }
    // Eager outside a batch: resolve straight through.
    this.pendingTarget = x;
    this.resolve();
  }
  get value(): T {
    return this.read();
  }

  /** Walk the put-chain from this view to its ultimate source and commit
   *  once. Intermediate lenses are traversed directly (not via the queue),
   *  so a depth-D chain is one O(D) walk per drained view — the SAME walk
   *  the eager path does, but run at most once, on demand, last-write. */
  resolve(): void {
    if (this.pendingTarget === NONE) return;
    let cur: Lens<unknown> = this as Lens<unknown>;
    let target: unknown = this.pendingTarget;
    this.pendingTarget = NONE;
    while (true) {
      const parent = cur.parent;
      counts.put++;
      const src = cur.readsSource ? (parent as { read(): unknown }).read() : (undefined as never);
      const push = cur.put(target as never, src as never);
      if (parent instanceof Source) {
        parent.writeSource(push);
        return;
      }
      cur = parent as Lens<unknown>;
      target = push;
    }
  }
}

function lens<P, T>(
  parent: Source<P> | Lens<P>,
  fwd: (p: P) => T,
  put: (target: T, current?: P) => P,
  readsSource = put.length >= 2,
): Lens<T> {
  return new Lens<T>(
    parent as AnyNode,
    fwd as (p: never) => T,
    put as (t: T, c?: never) => unknown,
    readsSource,
  );
}

// ─── Effect ──────────────────────────────────────────────────────────

class Effect {
  constructor(private readonly body: () => void) {
    this.run();
  }
  run(): void {
    counts.effectRuns++;
    const prev = activeEffect;
    activeEffect = this;
    try {
      this.body();
    } finally {
      activeEffect = prev;
    }
  }
}

// ─── Scenarios ───────────────────────────────────────────────────────

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const identity = <P>(s: Source<P> | Lens<P>): Lens<P> =>
  lens(
    s,
    (x: P) => x,
    (t: P) => t,
  );

const clampLens = (s: Source<number>, lo: number, hi: number): Lens<number> =>
  lens(
    s,
    x => Math.max(lo, Math.min(hi, x)),
    t => Math.max(lo, Math.min(hi, t)),
  );

console.log("push-pull backward — does drain-on-read subsume the patches?\n");

// 1. write-then-read consistency inside a batch (no eager walk).
{
  resetCounts();
  const s = new Source(0);
  const v = identity(s);
  let observed = NONE as number | typeof NONE;
  batch(() => {
    v.value = 5;
    observed = v.value; // read mid-batch → drains → resolves → sees 5
  });
  check("write-then-read sees the staged value", observed === 5, `got ${String(observed)}`);
  check("…and the source resolved to it", s.current === 5);
}

// 2. net-zero revert does NOT over-fire (no settled needed).
{
  resetCounts();
  const s = new Source(0);
  const v = identity(s);
  let seen = -1;
  new Effect(() => {
    seen = v.value;
  }); // initial run = 1
  const runsAfterInit = counts.effectRuns;
  batch(() => {
    v.value = 1;
    v.value = 0; // overwrite target → net zero
  });
  check(
    "effect did not re-run on net-zero",
    counts.effectRuns === runsAfterInit,
    `runs=${counts.effectRuns}`,
  );
  check("source never moved", s.current === 0 && counts.sourceWrites === 0);
  check("last value still correct", seen === 0);
}

// 3. cross-view consistency mid-batch (sibling view sees the write).
{
  resetCounts();
  const s = new Source(0);
  const a = identity(s);
  const b = identity(s);
  let viaB = NONE as number | typeof NONE;
  batch(() => {
    a.value = 9;
    viaB = b.value; // reading b drains → a's write committed → b sees 9
  });
  check("sibling view reflects the write", viaB === 9, `got ${String(viaB)}`);
}

// 4. lossy snapping: write out of range, read back the snapped value.
{
  resetCounts();
  const s = new Source(50);
  const v = clampLens(s, 0, 100);
  let back = NONE as number | typeof NONE;
  batch(() => {
    v.value = 999; // clamps to 100
    back = v.value;
  });
  check(
    "lossy lens snaps on write-then-read",
    back === 100 && s.current === 100,
    `got ${String(back)}`,
  );
}

// 5. coalescing: k writes to one view = ONE put-chain at flush.
{
  resetCounts();
  const s = new Source(0);
  const v = identity(s);
  batch(() => {
    for (let i = 1; i <= 100; i++) v.value = i; // last write wins → 100
  });
  check("100 writes coalesce to one resolution", counts.put === 1, `put=${counts.put}`);
  check("…landing the last value", s.current === 100);
}

// 6. deep chain: one observed write = ONE O(D) walk, not per-write.
{
  resetCounts();
  const s = new Source(0);
  let top: Lens<number> = identity(s);
  const D = 16;
  for (let i = 1; i < D; i++) top = identity(top);
  batch(() => {
    top.value = 7;
    top.value = 7; // repeated → still one walk
  });
  check("repeated deep writes = one D-deep walk", counts.put === D, `put=${counts.put} (D=${D})`);
  check("…source committed once", s.current === 7 && counts.sourceWrites === 1);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);

export {};
