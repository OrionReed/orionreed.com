// Reconciliation model — a clean-room sketch of a correct-by-construction
// bidirectional engine. The thesis, distilled from the eager / push-pull /
// BwdPending experiments:
//
//   A forward write and a backward write are THE SAME operation. Both stage a
//   pending value on a ROOT (a non-lens, non-derived signal — the only state)
//   and push invalidation; the getter pulls. The only difference is WHAT is
//   staged:
//       forward write  → a LITERAL          (root := v)
//       backward write → a DEFERRED put     (root := putChain(target))
//   plus the dual of a fan-in getter:
//       coupled write  → a shared RESOLUTION over N roots (one deferral each)
//
// Consequences (why this removes the special cases):
//   * Writes are PURE: they never compute or commit, only stage + invalidate.
//     So there is no mid-walk `peek` that commits, hence no `settled`.
//   * A staged deferral IS the root's pending value, gated by the SAME dirty
//     check as a forward write — no separate `BwdPending`, no read-path tax.
//   * Last-write-wins is overwrite; net-zero is "resolve == current" caught by
//     the root's ordinary equality check — no special net-zero handling.
//   * Eager vs batched is just "flush now vs at batch end" — one code path.
//   * Lossy snap, multi-out split, merge fold are all RESOLUTIONS. No bespoke
//     kinds. (NOTE: this file models a stateful lens's complement as an
//     auxiliary root for simplicity — but that is a reframe, not the truth.
//     State genuinely lives at roots AND on stateful lenses; a write can stop
//     partway, moving only a complement, with NO root touched. The honest
//     recursive model with complement-on-lens is in reconcile-multi.ts.)
//
// Backward no-op = PER-HOP, the dual of forward memoization: walk up the put-
// chain and STOP at the first node (root OR lens) whose value is unchanged.
// This is exact (no float drift), does less work, and is sound with siblings.
// Absorption that depends on lossy forward (clamp/quantise) is NOT engine-level
// — it lives in the lens `put` (locally correct to the lens), and per-hop then
// reports the no-op precisely.
//
// Representation note (matches the production target): a backward write stages
// (target, lens) on the root — NO per-write closure. The put-chain is the
// lens's PRECOMPILED `resolveRoot`, built once at construction and reused. A
// real engine would fold `pendingKind` into an alien-style `F` flag bitfield
// and use flat root fields; here it's an explicit small tag for readability.

// ─── Instrumentation ────────────────────────────────────────────────

const counts = { put: 0, recompute: 0, commit: 0, effectRun: 0 };
const resetCounts = (): void => {
  counts.put = counts.recompute = counts.commit = counts.effectRun = 0;
};

const eq = Object.is; // overridable per-cell in the real engine; Object.is default

// ─── Engine core ────────────────────────────────────────────────────

type Dependent = Computed<unknown> | Effect;
let observer: Dependent | undefined;
let batchDepth = 0;
const dirtyRoots = new Set<Root<unknown>>();
const pendingEffects = new Set<Effect>();

function schedule(r: Root<unknown>): void {
  dirtyRoots.add(r);
  if (batchDepth === 0) flush();
}

function flush(): void {
  // Commit staged roots (pull deferrals), which schedules effects on REAL
  // changes only; then run effects; repeat to a fixpoint (effects may write).
  let guard = 0;
  while (dirtyRoots.size > 0 || pendingEffects.size > 0) {
    if (++guard > 1_000_000) throw new Error("flush did not converge");
    for (const r of [...dirtyRoots]) r.realize();
    const fire = [...pendingEffects];
    pendingEffects.clear();
    for (const e of fire) e.run();
  }
}

export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}

/** Forward push: mark dependents stale, collect reachable effects. Runs ONLY
 *  when a root actually changes — the one place "dirtiness" originates. */
function invalidate(node: Root<unknown> | Computed<unknown>): void {
  for (const sub of node.subs) {
    if (sub instanceof Effect) pendingEffects.add(sub);
    else if (sub.valid) {
      sub.valid = false;
      invalidate(sub);
    }
  }
}

// ─── Root: the only state. Holds a pending LITERAL / DEFERRAL / THUNK. ──

// kind: 0 none · 1 literal · 2 deferred put-chain (target+lens) · 3 opaque
// (coupled resolution). `prev` (set only when a write READS its root) chains
// onto the prior pending → sequential semantics for history-dependent puts.
type Pending<T> =
  | { kind: 1; val: T; prev?: Pending<T> }
  | { kind: 2; target: unknown; lens: Lens<unknown>; prev?: Pending<T> }
  | { kind: 3; thunk: () => T; prev?: Pending<T> };

export class Root<T> {
  current: T;
  pending: Pending<T> | undefined;
  readonly subs = new Set<Dependent>();
  constructor(v: T) {
    this.current = v;
  }

  get(): T {
    if (this.pending !== undefined) this.realize();
    if (observer !== undefined) {
      this.subs.add(observer);
      observer.deps.add(this);
    }
    return this.current;
  }

  /** Forward write — a literal supersedes (ignores history). */
  set(v: T): void {
    this.pending = { kind: 1, val: v };
    schedule(this);
  }

  /** Backward write — stage (target, lens). No closure: the lens's precompiled
   *  `resolveRoot` is the put-chain. `composes` = "the chain reads its root". */
  stageDefer(target: unknown, lens: Lens<unknown>, composes: boolean): void {
    this.pending = { kind: 2, target, lens, prev: composes ? this.pending : undefined };
    schedule(this);
  }

  /** Coupled / opaque resolution (multi-root). Composes (reads current roots). */
  stageThunk(thunk: () => T, composes: boolean): void {
    this.pending = { kind: 3, thunk, prev: composes ? this.pending : undefined };
    schedule(this);
  }

  /** Pure: value of a pending chain against `current`, no commit/invalidate.
   *  Exposes the sequential base as `current` so a self-reading put sees it. */
  private valueOf(p: Pending<T>): T {
    if (p.kind === 1) return p.val;
    const base = p.prev !== undefined ? this.valueOf(p.prev) : this.current;
    const saved = this.current;
    this.current = base;
    try {
      return p.kind === 2 ? (p.lens.resolveRoot(p.target) as T) : p.thunk();
    } finally {
      this.current = saved;
    }
  }

  /** Pull: resolve the pending value, commit it, push invalidation iff changed. */
  realize(): void {
    const p = this.pending;
    if (p === undefined) {
      dirtyRoots.delete(this);
      return;
    }
    this.pending = undefined;
    dirtyRoots.delete(this);
    counts.commit++;
    const prev = observer;
    observer = undefined; // backward / resolution reads add no deps
    let next: T;
    try {
      next = this.valueOf(p);
    } finally {
      observer = prev;
    }
    if (!eq(next, this.current)) {
      this.current = next;
      invalidate(this);
    }
  }
}

// ─── Computed: pure forward function of roots (cached, pull-on-read). ──

export class Computed<T> {
  cached: T = undefined as T;
  valid = false;
  readonly deps = new Set<Root<unknown> | Computed<unknown>>();
  readonly subs = new Set<Dependent>();
  constructor(readonly fn: () => T) {}

  get(): T {
    if (!this.valid) this.recompute();
    if (observer !== undefined) {
      this.subs.add(observer);
      observer.deps.add(this);
    }
    return this.cached;
  }

  private recompute(): void {
    counts.recompute++;
    for (const d of this.deps) d.subs.delete(this);
    this.deps.clear();
    const prev = observer;
    observer = this;
    try {
      this.cached = this.fn();
      this.valid = true;
    } finally {
      observer = prev;
    }
  }
}

// ─── Effect: a watcher; re-runs only when a dep actually changed. ────

export class Effect {
  readonly deps = new Set<Root<unknown> | Computed<unknown>>();
  readonly subs = new Set<Dependent>(); // unused; satisfies Dependent shape
  constructor(readonly body: () => void) {
    this.run();
  }
  run(): void {
    counts.effectRun++;
    for (const d of this.deps) d.subs.delete(this);
    this.deps.clear();
    const prev = observer;
    observer = this;
    try {
      this.body();
    } finally {
      observer = prev;
    }
  }
}

// ─── Lens: forward = a Computed; backward = per-hop put-chain to the root. ──

type Readable<T> = Root<T> | Computed<T> | Lens<T>;

export class Lens<T> {
  readonly view: Computed<T>;
  readonly root: Root<unknown>;
  /** Static path view→root: [this, parentLens, …]. Precomputed once. */
  readonly chainDown: Lens<unknown>[];
  /** Does any hop read its parent? Then writes must compose (sequential). */
  readonly composes: boolean;

  constructor(
    private readonly parent: Readable<unknown>,
    private readonly fwd: (p: unknown) => T,
    private readonly put: (target: unknown, current?: unknown) => unknown,
    private readonly readsSource: boolean,
  ) {
    this.view = new Computed<T>(() => this.fwd(this.parent.get()));
    if (parent instanceof Lens) {
      this.chainDown = [this as Lens<unknown>, ...parent.chainDown];
      this.root = parent.root;
    } else if (parent instanceof Root) {
      this.chainDown = [this as Lens<unknown>];
      this.root = parent;
    } else {
      throw new Error("a lens must root at a Root or Lens, not a bare Computed");
    }
    this.composes = this.chainDown.some((l) => l.readsSource);
  }

  get(): T {
    return this.view.get();
  }
  get value(): T {
    return this.view.get();
  }
  /** Backward write: stage (target, this) on the root — no closure allocated. */
  set value(target: T) {
    this.root.stageDefer(target, this as Lens<unknown>, this.composes);
  }

  /** Precompiled put-chain with PER-HOP stop. The instant a node (lens OR root)
   *  already equals its incoming target, return the root's current value
   *  unchanged — exact, drift-free, sound. The current forward value at each
   *  hop is folded iteratively from the root (no reactive re-entry, no
   *  recursion); when the chain nodes are observed/cached a real engine reads
   *  the cache instead and skips the fold. */
  resolveRoot(target: unknown): unknown {
    counts.put++;
    const chain = this.chainDown;
    const n = chain.length;
    const rootCur = this.root.current;
    // current value at each hop, folded up from the root: cur[i] = fwd_i(cur[i+1])
    const cur = new Array<unknown>(n);
    cur[n - 1] = chain[n - 1].fwd(rootCur);
    for (let i = n - 2; i >= 0; i--) cur[i] = chain[i].fwd(cur[i + 1]);
    // put-chain top→down with per-hop stop
    let t: unknown = target;
    for (let i = 0; i < n; i++) {
      if (eq(t, cur[i])) return rootCur; // node unchanged → stop (can be a lens)
      const parentCur = chain[i].readsSource ? (i < n - 1 ? cur[i + 1] : rootCur) : undefined;
      t = chain[i].put(t, parentCur);
    }
    return t; // new root value
  }
}

export function lens<P, T>(
  parent: Readable<P>,
  fwd: (p: P) => T,
  put: (target: T, current?: P) => P,
  readsSource = put.length >= 2,
): Lens<T> {
  return new Lens<T>(
    parent as Readable<unknown>,
    fwd as (p: unknown) => T,
    put as (t: unknown, c?: unknown) => unknown,
    readsSource,
  );
}

// ─── Coupled (multi-out) write: ONE shared Resolution over N roots ──
//
// The dual of a fan-in getter. `compute(target)` returns the per-root edits;
// each root stages a deferral that runs the shared resolution once and takes
// its own edit. Same mechanism as a 1→1 deferral — just shared — so merge
// (accumulate) and the stateful complement (an auxiliary root) are the same
// shape, no bespoke kinds.

export function coupledWrite<T>(
  roots: Root<unknown>[],
  compute: (target: T) => Map<Root<unknown>, unknown>,
  target: T,
): void {
  let edits: Map<Root<unknown>, unknown> | undefined;
  const ensure = (): Map<Root<unknown>, unknown> => {
    if (edits === undefined) {
      counts.put++;
      edits = compute(target);
    }
    return edits;
  };
  for (const r of roots) {
    r.stageThunk(() => {
      const e = ensure();
      return e.has(r) ? e.get(r) : r.current;
    }, true); // resolutions read current roots → compose
  }
}

// ─── Scenarios: do the criteria fall out by construction? ───────────

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const identity = <T>(p: Readable<T>): Lens<T> =>
  lens(
    p,
    (x: T) => x,
    (t: T) => t,
  );

console.log("reconciliation model — criteria by construction\n");

// GetPut / net-zero: write current value, or revert, fires nothing.
{
  resetCounts();
  const s = new Root(0);
  const v = identity(s);
  let runs = 0;
  new Effect(() => {
    void v.value;
    runs++;
  });
  const base = runs;
  batch(() => {
    v.value = 1;
    v.value = 0;
  });
  check("net-zero revert fires no effect", runs === base, `runs=${runs - base}`);
  check("…root untouched", s.current === 0);
}

// PutGet round-trip (lossless) + write-then-read.
{
  resetCounts();
  const s = new Root(10);
  const v = lens(
    s,
    (x: number) => x * 2,
    (t: number) => t / 2,
  );
  let seen = -1;
  batch(() => {
    v.value = 30;
    seen = v.value;
  });
  check("PutGet: read-back equals written", seen === 30, `got ${seen}`);
  check("…root resolved via inverse", s.current === 15);
}

// Lossy: PutGet intentionally fails (snaps); falls out, no special case.
{
  resetCounts();
  const s = new Root(50);
  const v = lens(
    s,
    (x: number) => Math.max(0, Math.min(100, x)),
    (t: number) => Math.max(0, Math.min(100, t)),
  );
  let seen = -1;
  batch(() => {
    v.value = 999;
    seen = v.value;
  });
  check("lossy snaps on read-back", seen === 100 && s.current === 100, `got ${seen}`);
}

// Per-hop backward stop #1 — the dual of forward memoization. Writing a view's
// CURRENT value back is an EXACT no-op: halts at the written node, no float
// drift into the root, no sibling recompute. (Source-level would drift+fire.)
{
  resetCounts();
  const r = new Root(7);
  const h = (p: Readable<number>): Lens<number> =>
    lens(
      p,
      (x: number) => x * 0.1,
      (t: number) => t * 10,
    );
  const v = h(h(h(r))); // r·0.001 with FP error, 3 hops
  const w = lens(
    r,
    (x: number) => x * 2,
    (t: number) => t / 2,
  ); // sibling off the root
  let wRuns = 0;
  new Effect(() => {
    void w.value;
    wRuns++;
  });
  void v.value; // cache the deep view
  const r0 = r.current;
  const w0 = wRuns;
  const cur = v.value;
  v.value = cur; // write current value back
  check("per-hop: root stays EXACT (no FP drift)", eq(r.current, r0), `r=${r.current}`);
  check("per-hop: sibling effect not re-run", wRuns === w0, `wRuns=${wRuns - w0}`);
  v.value = cur + 1; // genuine change still propagates
  check("per-hop: genuine change still propagates", !eq(r.current, r0));
}

// Per-hop backward stop #2 — halting at an INTERMEDIATE lens node. A `put` that
// quantises (lens-encoded absorption) maps a sub-step nudge back to its
// parent's current value, so propagation stops AT that lens — root and the
// lens's other children are untouched.
{
  resetCounts();
  const r = new Root(10);
  const a = lens(
    r,
    (x: number) => x * 2,
    (t: number) => t / 2,
  ); // A = 20
  const v = lens(
    a,
    (x: number) => x,
    (t: number) => Math.round(t),
  ); // V rounds on write
  const w = lens(
    a,
    (x: number) => x + 100,
    (t: number) => t - 100,
  ); // sibling off A
  let wRuns = 0;
  new Effect(() => {
    void w.value;
    wRuns++;
  });
  void v.value;
  const r0 = r.current;
  const w0 = wRuns;
  v.value = 20.4; // put rounds → A-target 20 == A.current → STOP at A
  check("per-hop stops at an INTERMEDIATE lens node", eq(r.current, r0) && wRuns === w0, `r=${r.current} wRuns=${wRuns - w0}`);
  v.value = 21.6; // rounds → 22 ≠ 20 → crosses the boundary, propagates
  check("…and crossing the boundary propagates", r.current === 11, `r=${r.current}`);
}

// Cross-view consistency mid-batch.
{
  resetCounts();
  const s = new Root(0);
  const a = identity(s);
  const b = identity(s);
  let viaB = -1;
  batch(() => {
    a.value = 9;
    viaB = b.value;
  });
  check("sibling view reflects write mid-batch", viaB === 9, `got ${viaB}`);
}

// Glitch-freedom: a diamond observed once, consistently.
{
  resetCounts();
  const s = new Root(1);
  const a = new Computed(() => s.get() + 1);
  const b = new Computed(() => s.get() * 2);
  const c = new Computed(() => a.get() + b.get());
  const observed: number[] = [];
  new Effect(() => {
    observed.push(c.get());
  });
  const v = identity(s);
  v.value = 4; // s: 1→4 ⇒ c = (4+1)+(4*2) = 13
  check("diamond is glitch-free (no intermediate)", observed.every((x) => x === 1 + 1 + 2 || x === 13), `seen ${observed}`);
  check("…final consistent value", c.get() === 13);
  check("…effect ran once for the change", observed.length === 2, `runs=${observed.length}`);
}

// Coupled (centroid) write: one view-edit → N root edits, one resolution.
{
  resetCounts();
  const xs = [new Root(0), new Root(10), new Root(20)];
  const mean = new Computed(() => xs.reduce((a, s) => a + s.get(), 0) / xs.length);
  check("mean starts at 10", mean.get() === 10);
  coupledWrite(
    xs,
    (target: number) => {
      const cur = xs.reduce((a, s) => a + s.current, 0) / xs.length;
      const d = target - cur;
      return new Map(xs.map((s) => [s, s.current + d]));
    },
    13,
  );
  check("coupled write moves the mean", mean.get() === 13, `mean=${mean.get()}`);
  check("…all roots shifted by the delta", xs[0].current === 3 && xs[2].current === 23);
  check("…one shared resolution ran once", counts.put === 1, `put=${counts.put}`);
}

// Last-write-wins across distinct views of one root (PutPut).
{
  resetCounts();
  const s = new Root(0);
  const a = lens(
    s,
    (x: number) => x,
    (t: number) => t + 1,
  );
  const b = lens(
    s,
    (x: number) => x,
    (t: number) => t + 100,
  );
  batch(() => {
    a.value = 5; // would set s = 6
    b.value = 5; // would set s = 105 — last write wins
  });
  check("last write wins on shared root", s.current === 105, `s=${s.current}`);
}

// Deep chain + batched repeats: the asymptotic claim. k writes to a view that
// is `depth` lens-hops from its root. Eager backward is O(k·depth). Here the k
// writes are O(1) overwrites and the put-chain resolves ONCE on flush:
// O(k + depth).
{
  resetCounts();
  const depth = 1000;
  const k = 200;
  const s = new Root(0);
  let v: Lens<number> = identity(s);
  for (let i = 0; i < depth - 1; i++) {
    const inner: Lens<number> = v;
    v = lens(
      inner,
      (x: number) => x + 1,
      (t: number) => t - 1,
    );
  }
  let seen = -1;
  batch(() => {
    for (let i = 0; i < k; i++) v.value = i;
    seen = v.value; // forces resolve mid-batch (one pull)
  });
  check("deep chain: read-back correct", seen === k - 1, `got ${seen}`);
  check("deep chain: root = target - depth offset", s.current === k - 1 - (depth - 1), `s=${s.current}`);
  check(
    `deep chain: ${k} writes coalesced to ONE put-chain resolve`,
    counts.put === 1,
    `put=${counts.put} (eager would be ${k})`,
  );
}

// Stateful complement, NO bespoke kind: the complement is just an auxiliary
// Root. A stateful lens is a coupled write over [realRoot, complementRoot].
{
  resetCounts();
  const real = new Root(3);
  const comp = new Root(7); // invariant: real + comp == 10
  const view = new Computed(() => real.get());
  const sum = new Computed(() => real.get() + comp.get());
  check("stateful: starts shown=3, sum=10", view.get() === 3 && sum.get() === 10);
  coupledWrite(
    [real, comp],
    (target: number) => {
      const total = real.current + comp.current;
      return new Map<Root<unknown>, unknown>([
        [real, target],
        [comp, total - target],
      ]);
    },
    4,
  );
  check("stateful: view follows write", view.get() === 4, `view=${view.get()}`);
  check("stateful: complement conserves invariant", sum.get() === 10, `sum=${sum.get()}`);
  check("stateful: complement is just a root (no special kind)", comp.current === 6);
}

// Sequential coupling: a source-reading put whose root is edited earlier in the
// same batch. Resolve-at-pull reads the committed snapshot via the compose
// chain → sequential, no settled, no ordering hacks.
{
  resetCounts();
  const s = new Root(10);
  const v = lens(
    s,
    (x: number) => x,
    (t: number, cur?: number) => t + (cur ?? 0),
  );
  batch(() => {
    s.set(5); // composes underneath the deferral
    v.value = 100; // put(100, current=5) → 105
  });
  check("source-reading put sees prior batch edit", s.current === 105, `s=${s.current}`);
}

// ─── Randomized soundness across arbitrary DAGs ─────────────────────
//
// Random affine lens chains over a shared root pool (fan-out, varying depth →
// genuine DAGs); a random batch of view-writes; compare against an INDEPENDENT
// sequential oracle. Affine lenses (y = a·x + b, lossless) keep it exact.

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Affine = { a: number; b: number };
function randDAG(rng: () => number) {
  const nRoots = 1 + Math.floor(rng() * 4);
  const roots0 = Array.from({ length: nRoots }, () => Math.floor(rng() * 20) - 10);
  const nViews = 1 + Math.floor(rng() * 6);
  const views = Array.from({ length: nViews }, () => {
    const root = Math.floor(rng() * nRoots);
    const depth = 1 + Math.floor(rng() * 5);
    const hops: Affine[] = [];
    for (let i = 0; i < depth; i++) {
      const a = [1, 2, -1, -2][Math.floor(rng() * 4)];
      const b = Math.floor(rng() * 7) - 3;
      hops.push({ a, b });
    }
    return { root, hops };
  });
  const nWrites = 1 + Math.floor(rng() * 8);
  const writes = Array.from({ length: nWrites }, () => ({
    view: Math.floor(rng() * nViews),
    target: Math.floor(rng() * 40) - 20,
  }));
  return { roots0, views, writes };
}

function oracle(dag: ReturnType<typeof randDAG>): { roots: number[]; views: number[] } {
  const src = [...dag.roots0];
  const readView = (v: (typeof dag.views)[number]): number => {
    let x = src[v.root];
    for (const h of v.hops) x = h.a * x + h.b;
    return x;
  };
  for (const w of dag.writes) {
    const v = dag.views[w.view];
    let t = w.target;
    for (let i = v.hops.length - 1; i >= 0; i--) {
      const h = v.hops[i];
      t = (t - h.b) / h.a;
    }
    src[v.root] = t; // last write wins per root
  }
  return { roots: src, views: dag.views.map(readView) };
}

function runEngine(dag: ReturnType<typeof randDAG>): { roots: number[]; views: number[] } {
  const src = dag.roots0.map((v) => new Root(v));
  const views = dag.views.map((v) => {
    let node: Readable<number> = src[v.root];
    for (const h of v.hops) {
      const { a, b } = h;
      node = lens(
        node,
        (x: number) => a * x + b,
        (t: number) => (t - b) / a,
      );
    }
    return node as Lens<number>;
  });
  batch(() => {
    for (const w of dag.writes) views[w.view].value = w.target;
  });
  return { roots: src.map((s) => s.current), views: views.map((v) => v.get()) };
}

{
  let mismatches = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const dag = randDAG(mulberry(i + 1));
    const exp = oracle(dag);
    const got = runEngine(dag);
    // `===` so -0 and +0 compare equal: on a numeric no-op per-hop returns the
    // exact root (+0) while the oracle blindly computes (0)/(-a) = -0.
    const ok =
      exp.roots.every((x, k) => x === got.roots[k]) &&
      exp.views.every((x, k) => x === got.views[k]);
    if (!ok && mismatches < 3) {
      console.log(`  MISMATCH seed=${i + 1}`);
      console.log(`    exp roots=${JSON.stringify(exp.roots)} views=${JSON.stringify(exp.views)}`);
      console.log(`    got roots=${JSON.stringify(got.roots)} views=${JSON.stringify(got.views)}`);
    }
    if (!ok) mismatches++;
  }
  check(`randomized DAGs: ${N} topologies match sequential oracle`, mismatches === 0, `${mismatches} mismatch`);
}

console.log(`\n${failures === 0 ? "ALL PASS — criteria hold by construction" : `${failures} FAILURE(S)`}`);
