// relate.ts — first-class constraint relations over reactive cells.
//
// A `Relation` is a constraint binding N reactive `Num` cells together
// via a residual `R(x): R^N → R^M` that should equal zero. It does NOT
// pick a "direction" of dataflow — when any subset of cells is written
// by the user within a batch, the rest are solved (Newton, warm-started)
// to satisfy the residual.
//
// Multiple relations sharing cells form a *cluster* (transitive closure
// via union-find). The cluster solves jointly: a cluster with K cells
// and L relations has a combined residual of length L_total = Σ Mᵢ
// over K vars, of which the user-pinned subset is held fixed and the
// rest are Newton-stepped.
//
// Engine integration is minimal — two hooks added to `signal.ts`:
//
//   - `setPinHook` lets relate.ts observe user writes and bucket them
//     by cluster.
//   - `addPreFlushTask` lets the solver run *before* effects in
//     `flush()`, so effects always see post-solve state.
//
// Within a solver step, writes from the solver to free cells are
// suppressed from pin tracking via `withSolverActive`. This is the
// only mechanism by which the system distinguishes "user fixed this"
// from "solver determined this."
//
// Correctness criteria the relation runtime aims to satisfy:
//
//   CR1 — Confluence: post-batch state independent of write order.
//   CR2 — Consistency: post-flush, ‖residual‖ ≤ tol (or system reports
//                       residual via `cluster.health`).
//   CR3 — Steady-state stability: no writes ⇒ no drift across reads.
//   CR4 — Bounded propagation: each top-level write does O(maxIters ×
//                              cluster_size) work; never freezes.
//   CR5 — Determinism: same pre-state + writes ⇒ same post-state.
//   CR6 — Locality: writes only touch transitively-connected cells.
//   CR7 — Composition closure: stacking relations on shared cells
//                              yields one cluster whose semantics are
//                              the conjunction of the relations.
//   CR8 — Lens-law-like: well-determined clusters satisfy PutGet/
//                        GetPut/PutPut up to ε.
//
// Each is asserted in `_test/relate-laws.test.ts`.

import { dampedNewton, type NewtonResult, residualNorm } from "./solvers";
import {
  addPreFlushTask,
  computed,
  type Read,
  setPinHook,
  Signal,
  signal,
  type WritableBrand,
  withSolverActive,
} from "./signal";

// ─── Public types ────────────────────────────────────────────────────

type NumCell = Signal<number> & WritableBrand;

/** A residual function: takes the current values of the cluster cells
 *  in their declared order, writes residual components into `out`.
 *  Returning is unnecessary — `out` is the contract. The residual must
 *  be zero (componentwise) when constraints are satisfied.
 *
 *  Out-of-bounds writes are not checked; relations declare `m`
 *  (residual length) at construction and the runtime trusts it. */
export type Residual = (xs: readonly number[], out: number[]) => void;

export interface RelateOpts {
  /** Cells the relation binds. Order matters — `xs[i]` in `residual`
   *  refers to `cells[i]`. */
  cells: readonly NumCell[];
  /** Residual function. Writes `m` numbers into `out`. */
  residual: Residual;
  /** Length of the residual vector. */
  m: number;
  /** Diagnostic name. */
  name?: string;
}

export interface Relation {
  /** Cells bound by this relation, in declaration order. */
  readonly cells: readonly NumCell[];
  /** Number of residual components. */
  readonly m: number;
  /** Diagnostic name. */
  readonly name: string;
  /** L2 norm of the current residual (read-only signal). Updated after
   *  each solve. Use to drive UI ("constraint satisfied" indicator). */
  readonly residual: Read<number>;
  /** True iff `residual.value < tol`. Reactive. */
  readonly satisfied: Read<boolean>;
  /** Remove this relation. The cluster may split into smaller clusters
   *  if this was the only constraint joining two parts. */
  dispose(): void;
}

export interface ClusterHealth {
  /** Final residual norm at last solve. */
  residual: number;
  /** Iterations consumed at last solve. */
  iters: number;
  /** Whether last solve converged (residual ≤ tol). */
  converged: boolean;
}

// ─── Cluster ─────────────────────────────────────────────────────────

interface RelEntry {
  rel: RelationImpl;
  /** Index into cluster.cells per cell of this relation. Cached so
   *  residual evaluation doesn't relookup on each iteration. */
  cellIdx: number[];
}

interface Cluster {
  /** All cells reachable via constraints from any starting cell. */
  cells: NumCell[];
  /** All relations whose cells subset this cluster. */
  relations: RelEntry[];
  /** Cells the user has written within this batch (pre-flush). */
  pinned: Set<NumCell>;
  /** Total residual length (Σ rel.m). Used to size scratch buffers. */
  m: number;
  /** Persistent scratch buffers — sized to fit max(m, n) and reused
   *  across solves to avoid per-frame alloc. */
  xScratch: number[];
  rScratch: number[];
  pinMask: boolean[];
  /** Health observable (writable internal). */
  health: Signal<ClusterHealth>;
}

const cellToCluster = new WeakMap<NumCell, Cluster>();
const allClusters = new Set<Cluster>();
const dirtyClusters = new Set<Cluster>();
let scheduled = false;
let pinHookInstalled = false;

/** Hard pin: a cell whose value is *overridden* by the runtime to a
 *  fixed (or reactive) target on every solve, regardless of user
 *  writes. Distinct from user pin (per-batch automatic), distinct
 *  from a soft pin relation (residual minimised among others). Hard
 *  pins are the right primitive for "this is scaffolding": canvas
 *  origin, fixed corner, anchor — the user should not be able to
 *  drag these. */
type HardPinValue = number | (() => number);
const hardPinned = new WeakMap<NumCell, HardPinValue>();

/** Parent-tracking for lens cells: when the user writes a parent
 *  signal (e.g. a Vec source `A`), the engine fires `pinHook(A)`. The
 *  cluster cells are A.x, A.y — derived field lenses, NOT A. Without
 *  this map, the pin event would be dropped on the floor. The map
 *  routes a pin on the parent to pinning all its registered lens
 *  cells. Populated by constraint factories that consume composite
 *  values (Vec, Box, etc.) — see `point()` in `constraints.ts`. */
const sourceToLensCells = new WeakMap<Signal<unknown>, NumCell[]>();

const tol = 1e-9;
// Per-flush iteration budget. 64 is comfortable for most clusters
// we've benchmarked (4-bar warm-start: 1-2; equilateral: 3-4;
// strandbeest leg: 8-12; 4×4 mass-spring lattice: 12-20). Larger
// systems may need to span multiple flushes; for now we cap and
// accept partial convergence (the cluster's `health` signal exposes
// the residual so consumers can react to non-convergence).
const maxIters = 64;

function ensureSetup(): void {
  if (pinHookInstalled) return;
  pinHookInstalled = true;
  setPinHook(sig => {
    // Direct cluster cell? — pin it.
    const cluster = cellToCluster.get(sig as NumCell);
    if (cluster !== undefined) {
      cluster.pinned.add(sig as NumCell);
      dirtyClusters.add(cluster);
      schedulePostFlush();
      return;
    }
    // Parent of one or more cluster cells (e.g. a Vec source whose
    // .x / .y field lenses are in clusters)? — pin all of them.
    const lensCells = sourceToLensCells.get(sig);
    if (lensCells !== undefined) {
      for (const lc of lensCells) {
        const cl = cellToCluster.get(lc);
        if (cl !== undefined) {
          cl.pinned.add(lc);
          dirtyClusters.add(cl);
        }
      }
      schedulePostFlush();
    }
  });
}

function schedulePostFlush(): void {
  if (!scheduled) {
    scheduled = true;
    addPreFlushTask(drainSolves);
  }
}

/** Register `source` as a parent of `lensCells`. When the user writes
 *  `source`, every cell in `lensCells` is pinned in its cluster.
 *  Idempotent — re-registering with overlapping cells appends. */
export function trackLensSource(source: Signal<unknown>, lensCells: readonly NumCell[]): void {
  ensureSetup();
  const existing = sourceToLensCells.get(source);
  if (existing !== undefined) {
    for (const c of lensCells) if (!existing.includes(c)) existing.push(c);
  } else {
    sourceToLensCells.set(source, lensCells.slice());
  }
}

function drainSolves(): void {
  scheduled = false;
  if (dirtyClusters.size === 0) return;
  // Snapshot — solving may add more clusters to the dirty set if
  // constraint hops cross cluster boundaries (currently impossible
  // because clusters are by construction disjoint, but future
  // dynamic reconfiguration may need this).
  const snapshot = Array.from(dirtyClusters);
  dirtyClusters.clear();
  withSolverActive(() => {
    for (const c of snapshot) solveCluster(c);
  });
}

function newCluster(): Cluster {
  const c: Cluster = {
    cells: [],
    relations: [],
    pinned: new Set(),
    m: 0,
    xScratch: [],
    rScratch: [],
    pinMask: [],
    health: signal<ClusterHealth>({ residual: 0, iters: 0, converged: true }),
  };
  allClusters.add(c);
  return c;
}

/** Merge cluster `b` into cluster `a` (if distinct). Updates `cellToCluster`
 *  for every cell in b, transfers relations and pinned cells, and
 *  removes `b` from `allClusters`. Returns the surviving cluster `a`. */
function mergeClusters(a: Cluster, b: Cluster): Cluster {
  if (a === b) return a;
  for (const cell of b.cells) {
    a.cells.push(cell);
    cellToCluster.set(cell, a);
  }
  // Translate cellIdx references in b's relations to point at a's
  // cells array (which now contains b's cells appended).
  // The cellIdx values were indices into b.cells; rebuild against a.
  // We'll rebuild below by scanning a.cells for each rel cell.
  for (const entry of b.relations) {
    const idx = new Array<number>(entry.rel.cells.length);
    for (let i = 0; i < entry.rel.cells.length; i++) {
      idx[i] = a.cells.indexOf(entry.rel.cells[i]!);
    }
    a.relations.push({ rel: entry.rel, cellIdx: idx });
    entry.rel._cluster = a;
  }
  for (const p of b.pinned) a.pinned.add(p);
  a.m += b.m;
  resizeScratch(a);
  allClusters.delete(b);
  if (dirtyClusters.has(b)) {
    dirtyClusters.delete(b);
    dirtyClusters.add(a);
  }
  return a;
}

function resizeScratch(c: Cluster): void {
  if (c.xScratch.length < c.cells.length) c.xScratch.length = c.cells.length;
  if (c.rScratch.length < c.m) c.rScratch.length = c.m;
  if (c.pinMask.length < c.cells.length) c.pinMask.length = c.cells.length;
}

// ─── Solver ──────────────────────────────────────────────────────────

function buildResidual(c: Cluster): Residual {
  // Build a closure that, given the cluster's flat x vector, evaluates
  // every relation's residual into the right offsets in `out`. Cached
  // cell indices avoid per-call lookups.
  const rels = c.relations;
  return (xs, out) => {
    let off = 0;
    for (let r = 0; r < rels.length; r++) {
      const entry = rels[r]!;
      const rel = entry.rel;
      const idx = entry.cellIdx;
      const subX = rel._argScratch;
      for (let i = 0; i < idx.length; i++) subX[i] = xs[idx[i]!]!;
      const subR = rel._outScratch;
      rel.residualFn(subX, subR);
      for (let i = 0; i < rel.m; i++) out[off + i] = subR[i]!;
      off += rel.m;
    }
  };
}

function solveCluster(c: Cluster): void {
  if (c.m === 0) return;
  resizeScratch(c);
  const n = c.cells.length;
  const xs = c.xScratch;
  for (let i = 0; i < n; i++) {
    const cell = c.cells[i]!;
    const hp = hardPinned.get(cell);
    if (hp !== undefined) {
      // Hard-pinned: solver enforces this value, overriding any user
      // write. Reactive targets (function form) re-read each solve.
      xs[i] = typeof hp === "function" ? hp() : hp;
      c.pinMask[i] = true;
    } else {
      xs[i] = cell.peek();
      c.pinMask[i] = c.pinned.has(cell);
    }
  }
  const R = buildResidual(c);
  const result: NewtonResult = dampedNewton(xs, R, c.m, c.pinMask, {
    maxIters,
    tol,
  });
  // (We considered persisting `c.lambda` across solves to warm-start
  // the trust region, but in practice the per-call default of 1e-6
  // converges as fast or faster on our test workloads — the rejection
  // bumps that adapt λ within one call cover small drift well, and
  // persisting can carry over a too-aggressive λ from a lucky prior
  // frame and force several rejection cycles. Keep it simple.)

  // Write back any cell whose final xs differs from its current value.
  // - Free cells: Newton may have moved them.
  // - User-pinned cells: xs[i] = peek (no change, write is no-op).
  // - Hard-pinned cells: xs[i] = pin value, peek may differ (e.g.
  //   user just wrote a different value that the pin overrides).
  // Solver writes are suppressed from pin tracking via
  // withSolverActive in the caller.
  for (let i = 0; i < n; i++) {
    const cell = c.cells[i]!;
    const cur = cell.peek();
    if (cur !== xs[i]) cell.value = xs[i]!;
  }

  c.pinned.clear();

  // Update health. Each relation's individual residual norm is also
  // recomputed for satisfaction-signal use.
  c.health.value = {
    residual: result.residual,
    iters: result.iters,
    converged: result.converged,
  };
  // Per-relation residual updates.
  let off = 0;
  for (const entry of c.relations) {
    const rel = entry.rel;
    let s = 0;
    for (let i = 0; i < rel.m; i++) s += c.rScratch[off + i]! ** 2;
    // rScratch contains the FINAL residual from dampedNewton's last R
    // evaluation. Note: dampedNewton evaluates R(x) at the start and
    // overwrites `r` on accepted steps — when it returns, r contains
    // R(final_x).  We re-evaluate to be sure.
    off += rel.m;
    rel._residualSig.value = Math.sqrt(s);
  }
  // Re-evaluate to fill rel._residualSig accurately. (The above used
  // stale rScratch from before the last accepted step.) Cheap one
  // pass.
  R(xs, c.rScratch);
  off = 0;
  for (const entry of c.relations) {
    const rel = entry.rel;
    let s = 0;
    for (let i = 0; i < rel.m; i++) s += c.rScratch[off + i]! ** 2;
    rel._residualSig.value = Math.sqrt(s);
    off += rel.m;
  }
  void residualNorm;
}

// ─── Relation impl ───────────────────────────────────────────────────

class RelationImpl implements Relation {
  readonly cells: readonly NumCell[];
  readonly m: number;
  readonly name: string;
  readonly residualFn: Residual;
  readonly residual: Read<number>;
  readonly satisfied: Read<boolean>;
  /** @internal — cluster pointer, updated on merge. */
  _cluster!: Cluster;
  _residualSig: Signal<number>;
  /** @internal — scratch buffers reused across solver calls. */
  _argScratch: number[];
  _outScratch: number[];
  private _disposed = false;

  constructor(opts: RelateOpts) {
    this.cells = opts.cells;
    this.m = opts.m;
    this.name = opts.name ?? "anon";
    this.residualFn = opts.residual;
    this._argScratch = new Array<number>(opts.cells.length);
    this._outScratch = new Array<number>(opts.m);
    this._residualSig = signal(Number.POSITIVE_INFINITY);
    this.residual = this._residualSig;
    this.satisfied = computed(() => this._residualSig.value < 1e-6);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const c = this._cluster;
    const idx = c.relations.findIndex(e => e.rel === this);
    if (idx >= 0) c.relations.splice(idx, 1);
    c.m -= this.m;
    // Note: doesn't currently split clusters when removing a relation
    // disconnects the graph. Easy to add via re-running cluster
    // identification; not done in v0 for simplicity. If a cluster
    // becomes constraint-free (m === 0), cells stay associated but
    // solver no-ops on it.
  }
}

// ─── Public factory ──────────────────────────────────────────────────

export function relate(opts: RelateOpts): Relation {
  ensureSetup();
  const rel = new RelationImpl(opts);

  // Cluster identification: union-find over the cells. Find existing
  // clusters for any of rel's cells; merge them, plus any new cells.
  let target: Cluster | undefined;
  for (const cell of opts.cells) {
    const existing = cellToCluster.get(cell);
    if (existing === undefined) continue;
    if (target === undefined) target = existing;
    else if (target !== existing) target = mergeClusters(target, existing);
  }
  if (target === undefined) target = newCluster();

  // Add any cells not already in target.
  for (const cell of opts.cells) {
    if (cellToCluster.get(cell) !== target) {
      target.cells.push(cell);
      cellToCluster.set(cell, target);
    }
  }
  resizeScratch(target);

  // Register relation against its cluster.
  const cellIdx = new Array<number>(opts.cells.length);
  for (let i = 0; i < opts.cells.length; i++) {
    cellIdx[i] = target.cells.indexOf(opts.cells[i]!);
  }
  target.relations.push({ rel, cellIdx });
  target.m += opts.m;
  rel._cluster = target;

  // Prime: solve immediately so the new relation's residual is up to
  // date and (if cells are far from satisfaction) the cluster
  // converges. Without this, "add a constraint, see the figure snap
  // into place" requires the user to wiggle a cell first.
  //
  // Direct solve (rather than queue-via-flush) keeps construction
  // semantically synchronous: constructing N relations in a row and
  // then reading any of their residuals gets the joint-solved state.
  // Any user pins already accumulated this batch are honoured (they
  // were recorded by pinHook before construction).
  withSolverActive(() => solveCluster(target));
  // The direct solve cleared `pinned`. Make sure the cluster isn't
  // also queued for a redundant re-solve via the flush task.
  dirtyClusters.delete(target);

  return rel;
}

// ─── Diagnostics ─────────────────────────────────────────────────────

/** Cluster diagnostic for a cell. Returns the cluster's current health
 *  (residual, iters, converged) as a reactive signal. Use for UI:
 *  flag over-constrained clusters, show "settling" during relaxation. */
export function clusterHealth(cell: NumCell): Read<ClusterHealth> | undefined {
  const c = cellToCluster.get(cell);
  return c?.health;
}

// ─── Hard pins ───────────────────────────────────────────────────────

/** Mark `cell` as hard-pinned at `value` (literal or thunk). The
 *  cluster solver overrides this cell on every solve, regardless of
 *  whether the user wrote it. Returns a `dispose()` that removes the
 *  hard pin (the cell becomes writable again).
 *
 *  This is the right primitive for "scaffolding" cells (anchors,
 *  fixed origins, immobile corners). User writes to hard-pinned cells
 *  are silently overridden on the next solve.
 *
 *  Distinct from `pin` in `constraints.ts`, which is a soft relation
 *  added to the residual stack (least-squares minimisation). Use
 *  `hardPin` when you need true immobility. */
export function hardPin(cell: NumCell, value: HardPinValue): () => void {
  ensureSetup();
  hardPinned.set(cell, value);
  // Solve immediately if this cell is already in a cluster. Mirror
  // relate()'s synchronous-solve semantics so that "add a hard pin,
  // see the figure snap" works without requiring a downstream write.
  const cluster = cellToCluster.get(cell);
  if (cluster !== undefined) {
    withSolverActive(() => solveCluster(cluster));
    dirtyClusters.delete(cluster);
  } else {
    // Not in a cluster yet — write directly via withSolverActive so
    // the value sticks without firing pin hook.
    withSolverActive(() => {
      const v = typeof value === "function" ? value() : value;
      cell.value = v;
    });
  }
  return () => {
    hardPinned.delete(cell);
  };
}

/** Predicate: is `cell` hard-pinned? */
export function isHardPinned(cell: NumCell): boolean {
  return hardPinned.has(cell);
}

/** Number of cells in the cluster containing `cell`. Useful for
 *  test instrumentation and debug overlays. */
export function clusterSize(cell: NumCell): number {
  const c = cellToCluster.get(cell);
  return c?.cells.length ?? 0;
}

/** Total registered constraint clusters (for tests). */
export function _allClusters(): readonly Cluster[] {
  return Array.from(allClusters);
}
