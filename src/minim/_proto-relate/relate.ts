// relate.ts — first-class constraint relations over reactive cells.
//
// A `Relation` binds N reactive cells together via a residual
// `R(x): R^N → R^M` that should equal zero. It does NOT pick a
// "direction" of dataflow — when any subset of cells is written by
// the user within a batch, the rest are solved (Newton, warm-started)
// to satisfy the residual.
//
// Cells are first-class signals — Num, Vec, Box, or any value class
// that declares a `packer` trait (`{ dim, pack, unpack }`). The
// runtime translates between the cluster's flat solver state and
// the cells' typed values transparently. The residual function
// receives an array of TYPED values (one entry per cell) and writes
// residual components into a flat output array.
//
// No wrapping is needed — pass signals directly. A Vec source cell
// has dim 2 in the solver, occupying two adjacent slots; a Num cell
// has dim 1. Pin events on a Vec source pin both slots automatically.
//
// Multiple relations sharing cells form a *cluster* (transitive
// closure via union-find). The cluster solves jointly.
//
// Engine integration is minimal — three hooks added to `signal.ts`:
//
//   - `setPinHook` lets relate.ts observe user writes and bucket
//     them by cluster.
//   - `addPreFlushTask` lets the solver run *before* effects in
//     `flush()`, so effects always see post-solve state.
//   - `withSolverActive` gates `pinHook` so solver writes don't
//     re-trigger the cluster they came from.
//
// Correctness criteria the relation runtime aims to satisfy:
//
//   CR1 — Confluence: post-batch state independent of write order.
//   CR2 — Consistency: post-flush, ‖residual‖ ≤ tol (or system
//                       reports residual via `cluster.health`).
//   CR3 — Steady-state stability: no writes ⇒ no drift across reads.
//   CR4 — Bounded propagation: each top-level write does O(maxIters
//                              × cluster_size) work; never freezes.
//   CR5 — Determinism: same pre-state + writes ⇒ same post-state.
//   CR6 — Locality: writes only touch transitively-connected cells.
//   CR7 — Composition closure: stacking relations on shared cells
//                              yields one cluster whose semantics
//                              are the conjunction of the relations.
//   CR8 — Lens-law-like: well-determined clusters satisfy PutGet/
//                        GetPut/PutPut up to ε.
//
// Each is asserted in `_test/relate-laws.test.ts`.

import {
  addPreFlushTask,
  computed,
  type Read,
  Signal,
  setPinHook,
  signal,
  type WritableBrand,
  withSolverActive,
} from "./signal";
import { dampedNewton, type NewtonResult, residualNorm } from "./solvers";
import {
  buildSparseInfo,
  dampedNewtonSparse,
  type SparseInfo,
  type SparseNewtonResult,
} from "./solvers-sparse";
import type { Packer, TraitDict } from "./traits";

// ─── Public types ────────────────────────────────────────────────────

/** Any reactive cell with a declared `packer` trait. The runtime
 *  uses the packer to translate to/from the solver's flat state.
 *  Default packer (when not declared) treats the cell as a scalar
 *  Num — `dim = 1`, value = the cell's `.value`. */
// biome-ignore lint/suspicious/noExplicitAny: cells are heterogeneous
export type Cell = Signal<any> & WritableBrand & { value: any };

/** A residual function: receives an array of typed cell values (one
 *  per cell, in declaration order — Num cells supply `number`, Vec
 *  cells supply `{x,y}`, etc.) and writes `m` residual components
 *  into `out`. Components must equal zero when the constraint is
 *  satisfied.
 *
 *  Out-of-bounds writes to `out` are not checked; relations declare
 *  `m` (residual length) at construction and the runtime trusts it. */
// biome-ignore lint/suspicious/noExplicitAny: typed values per cell
export type Residual = (vals: readonly any[], out: number[]) => void;

export interface RelateOpts {
  /** Cells the relation binds. Order matters — `vals[i]` in
   *  `residual` is the typed value of `cells[i]`. */
  cells: readonly Cell[];
  /** Residual function. Writes `m` numbers into `out`. */
  residual: Residual;
  /** Length of the residual vector. */
  m: number;
  /** Soft-constraint strength. Residual entries are multiplied by
   *  `sqrt(weight)` before contributing to the cluster's combined
   *  least-squares objective; high weights dominate. Cassowary-
   *  style conventions:
   *
   *    WEAK     ≈ 1
   *    MEDIUM   ≈ 1e3
   *    STRONG   ≈ 1e6
   *    REQUIRED ≈ 1e9   (effectively "always-satisfied")
   *
   *  Defaults to 1 (everyone equal). */
  weight?: number;
  /** Diagnostic name. */
  name?: string;
}

/** Cassowary-style strength constants. Use as `weight: STRONG` to
 *  give a constraint priority over `MEDIUM`-strength ones. */
export const Strength = {
  WEAK: 1,
  MEDIUM: 1e3,
  STRONG: 1e6,
  REQUIRED: 1e9,
} as const;

export interface Relation {
  /** Cells bound by this relation, in declaration order. */
  readonly cells: readonly Cell[];
  /** Number of residual components. */
  readonly m: number;
  /** Diagnostic name. */
  readonly name: string;
  /** L2 norm of the current residual (read-only signal). Updated
   *  after each solve. */
  readonly residual: Read<number>;
  /** True iff `residual.value < tol`. Reactive. */
  readonly satisfied: Read<boolean>;
  /** Remove this relation. */
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

// ─── Packer lookup ───────────────────────────────────────────────────

const SCALAR_PACKER: Packer<number> = {
  dim: 1,
  pack: (v, into, off) => {
    into[off] = v;
  },
  unpack: (from, off) => from[off]!,
};

function packerOf(cell: Cell): Packer<unknown> {
  const cls = cell.constructor as { traits?: TraitDict<unknown> };
  const p = cls.traits?.packer;
  return (p as Packer<unknown>) ?? (SCALAR_PACKER as Packer<unknown>);
}

// ─── Cluster ─────────────────────────────────────────────────────────

interface CellEntry {
  cell: Cell;
  packer: Packer<unknown>;
  /** Offset of this cell's slots within the cluster's flat state. */
  offset: number;
}

interface RelEntry {
  rel: RelationImpl;
  /** Index into cluster.cellEntries per cell of this relation.
   *  Cached so residual evaluation doesn't relookup on each iter. */
  cellIdx: number[];
}

interface Cluster {
  /** Cells in this cluster, with their packers and slot offsets. */
  cellEntries: CellEntry[];
  /** Total dim (sum of cell.packer.dim). Length of the flat solver
   *  state vector for this cluster. */
  totalDim: number;
  /** All relations whose cells subset this cluster. */
  relations: RelEntry[];
  /** Cells the user has written within this batch (pre-flush). */
  pinned: Set<Cell>;
  /** Total residual length (Σ rel.m). */
  m: number;
  /** Persistent scratch buffers — sized to fit max(m, totalDim) and
   *  reused across solves to avoid per-frame alloc. */
  xScratch: number[];
  rScratch: number[];
  pinMask: boolean[];
  /** Per-cell typed value scratch — one entry per cell, reused. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous values
  valsScratch: any[];
  /** Health observable. */
  health: Signal<ClusterHealth>;
  /** Cached sparsity info; invalidated when relations are added or
   *  removed. The runtime builds this lazily — only clusters that
   *  qualify for the sparse path materialise it. */
  sparseInfo?: SparseInfo;
  /** True iff this cluster is being solved via the sparse path.
   *  Determined at sparseInfo construction; sticks until topology
   *  changes. */
  useSparse?: boolean;
  /** Persistent banded-storage scratch for the sparse path, sized
   *  to `nf × (bandwidth + 1)`. Reallocated on topology change. */
  sparseScratch?: number[];
}

const cellToCluster = new WeakMap<Cell, Cluster>();
const allClusters = new Set<Cluster>();
const dirtyClusters = new Set<Cluster>();
let scheduled = false;
let pinHookInstalled = false;

/** Hard pin: a cell whose value is *overridden* by the runtime to a
 *  fixed (or reactive) target on every solve, regardless of user
 *  writes. The closure form lets consumers point the pin at a
 *  reactive parameter (re-read on every solve). Polymorphic — for
 *  Num cells it returns a number; for Vec cells, a `{x, y}`; etc. */
const hardPinned = new WeakMap<Cell, () => unknown>();

/** Backward-compat parent-tracking: pinning `source` pins all the
 *  cells in `sourceToLensCells.get(source)`. Used for the
 *  field-lens-with-composite-parent pattern (cluster has Vec.x and
 *  Vec.y, user writes Vec.value). Most users should pass the
 *  composite (Vec) as the cell directly — the runtime auto-handles
 *  it via the Vec packer. */
const sourceToLensCells = new WeakMap<Signal<unknown>, Cell[]>();

function ensureSetup(): void {
  if (pinHookInstalled) return;
  pinHookInstalled = true;
  setPinHook(sig => {
    // Direct cluster cell? — pin it.
    const cluster = cellToCluster.get(sig as Cell);
    if (cluster !== undefined) {
      cluster.pinned.add(sig as Cell);
      dirtyClusters.add(cluster);
      schedulePostFlush();
      return;
    }
    // Backward-compat: parent of one or more cluster cells via
    // `trackLensSource`. Pin all of them. Used when consumers
    // decompose a composite (Vec, Box) into per-axis Nums but
    // still want composite-write pin propagation.
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

function drainSolves(): void {
  scheduled = false;
  if (dirtyClusters.size === 0) return;
  const snapshot = Array.from(dirtyClusters);
  dirtyClusters.clear();
  withSolverActive(() => {
    for (const c of snapshot) solveCluster(c);
  });
}

function newCluster(): Cluster {
  const c: Cluster = {
    cellEntries: [],
    totalDim: 0,
    relations: [],
    pinned: new Set(),
    m: 0,
    xScratch: [],
    rScratch: [],
    pinMask: [],
    valsScratch: [],
    health: signal<ClusterHealth>({ residual: 0, iters: 0, converged: true }),
  };
  allClusters.add(c);
  return c;
}

/** Merge cluster `b` into cluster `a` (if distinct). */
function mergeClusters(a: Cluster, b: Cluster): Cluster {
  if (a === b) return a;
  // Re-offset b's cells onto a's flat state.
  for (const e of b.cellEntries) {
    e.offset = a.totalDim;
    a.cellEntries.push(e);
    a.totalDim += e.packer.dim;
    cellToCluster.set(e.cell, a);
  }
  // Translate cellIdx references in b's relations to point at a's
  // cellEntries array (b's were appended at the end).
  for (const entry of b.relations) {
    const idx = new Array<number>(entry.rel.cells.length);
    for (let i = 0; i < entry.rel.cells.length; i++) {
      const cell = entry.rel.cells[i]!;
      idx[i] = a.cellEntries.findIndex(e => e.cell === cell);
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
  if (c.xScratch.length < c.totalDim) c.xScratch.length = c.totalDim;
  if (c.rScratch.length < c.m) c.rScratch.length = c.m;
  if (c.pinMask.length < c.totalDim) c.pinMask.length = c.totalDim;
  if (c.valsScratch.length < c.cellEntries.length) c.valsScratch.length = c.cellEntries.length;
}

// ─── Solver ──────────────────────────────────────────────────────────

/** Threshold for sparse-path dispatch. Below this slot count, the
 *  dense LU's per-call setup overhead dominates and the sparse
 *  path's per-call alloc + bookkeeping makes it slower. Tuned
 *  empirically on chain workloads — the crossover is around 30-40
 *  slots; below this dense wins, above sparse wins (sometimes by
 *  orders of magnitude). */
const SPARSE_DISPATCH_THRESHOLD = 32;

/** Compute per-cluster sparsity descriptor: which slots each
 *  constraint touches, and inverse map. Built once per topology
 *  change and cached. */
function buildClusterSparseInfo(c: Cluster): SparseInfo {
  const constraintSlots: number[][] = [];
  for (const entry of c.relations) {
    const rel = entry.rel;
    const slots: number[] = [];
    for (let i = 0; i < entry.cellIdx.length; i++) {
      const cellIdx = entry.cellIdx[i]!;
      const cellEntry = c.cellEntries[cellIdx]!;
      const off = cellEntry.offset;
      const dim = cellEntry.packer.dim;
      for (let k = 0; k < dim; k++) slots.push(off + k);
    }
    // The same `slots` array is replicated for each of rel.m
    // residuals — each residual depends on the same cells.
    for (let i = 0; i < rel.m; i++) constraintSlots.push(slots.slice());
  }
  return buildSparseInfo(constraintSlots, c.totalDim);
}

/** Build a residual function that evaluates ONLY the constraint
 *  indices in `which`, leaving other entries of `out` untouched.
 *  Used by the sparse FD step to avoid full-cluster R evals. */
function buildResidualSubset(
  c: Cluster,
): (xs: readonly number[], which: readonly number[], out: number[]) => void {
  const rels = c.relations;
  const cellEntries = c.cellEntries;
  const valsScratch = c.valsScratch;
  // For each residual index in the cluster's flat residual vector,
  // which relation owns it and at what local offset.
  const residualToRel = new Int32Array(c.m);
  const residualLocal = new Int32Array(c.m);
  let rOff = 0;
  for (let r = 0; r < rels.length; r++) {
    const rm = rels[r]!.rel.m;
    for (let i = 0; i < rm; i++) {
      residualToRel[rOff + i] = r;
      residualLocal[rOff + i] = i;
    }
    rOff += rm;
  }
  // Per-relation residual block start in cluster's flat vector.
  const relOffset = new Int32Array(rels.length);
  let off = 0;
  for (let r = 0; r < rels.length; r++) {
    relOffset[r] = off;
    off += rels[r]!.rel.m;
  }
  return (xs, which, out) => {
    // Determine which RELATIONS need re-eval. A relation needs
    // re-eval if any of its m residual indices appears in `which`.
    // Build a Set on the fly.
    const seenRel = new Set<number>();
    for (const idx of which) {
      seenRel.add(residualToRel[idx]!);
    }
    for (const r of seenRel) {
      const entry = rels[r]!;
      const rel = entry.rel;
      const idxList = entry.cellIdx;
      const subVals = rel._argScratch;
      // Unpack just the cells this relation needs.
      for (let i = 0; i < idxList.length; i++) {
        const ci = idxList[i]!;
        const e = cellEntries[ci]!;
        valsScratch[ci] = e.packer.unpack(xs, e.offset);
        subVals[i] = valsScratch[ci];
      }
      const subR = rel._outScratch;
      rel.residualFn(subVals, subR);
      const w = rel._sqrtWeight;
      const blockStart = relOffset[r]!;
      if (w === 1) {
        for (let i = 0; i < rel.m; i++) out[blockStart + i] = subR[i]!;
      } else {
        for (let i = 0; i < rel.m; i++) out[blockStart + i] = subR[i]! * w;
      }
    }
  };
}

function buildResidual(c: Cluster): (xs: readonly number[], out: number[]) => void {
  const rels = c.relations;
  const cellEntries = c.cellEntries;
  const valsScratch = c.valsScratch;
  return (xs, out) => {
    // Unpack ALL cells once — relations share the typed values.
    for (let i = 0; i < cellEntries.length; i++) {
      const e = cellEntries[i]!;
      valsScratch[i] = e.packer.unpack(xs, e.offset);
    }
    let off = 0;
    for (let r = 0; r < rels.length; r++) {
      const entry = rels[r]!;
      const rel = entry.rel;
      const idx = entry.cellIdx;
      const subVals = rel._argScratch;
      for (let i = 0; i < idx.length; i++) subVals[i] = valsScratch[idx[i]!];
      const subR = rel._outScratch;
      rel.residualFn(subVals, subR);
      // Apply per-relation weight (sqrt scales the LSQ contribution
      // linearly in `weight`).
      const w = rel._sqrtWeight;
      if (w === 1) {
        for (let i = 0; i < rel.m; i++) out[off + i] = subR[i]!;
      } else {
        for (let i = 0; i < rel.m; i++) out[off + i] = subR[i]! * w;
      }
      off += rel.m;
    }
  };
}

function solveCluster(c: Cluster): void {
  if (c.m === 0) return;
  resizeScratch(c);
  const totalDim = c.totalDim;
  const xs = c.xScratch;

  // Pack each cell's value into the flat state.
  for (const e of c.cellEntries) {
    const hp = hardPinned.get(e.cell);
    if (hp !== undefined) {
      e.packer.pack(hp(), xs, e.offset);
      for (let k = 0; k < e.packer.dim; k++) c.pinMask[e.offset + k] = true;
    } else {
      e.packer.pack(e.cell.peek(), xs, e.offset);
      const userPinned = c.pinned.has(e.cell);
      for (let k = 0; k < e.packer.dim; k++) c.pinMask[e.offset + k] = userPinned;
    }
  }

  // Lazy sparsity info build + dispatch decision. We use the sparse
  // path when:
  //   - totalDim ≥ SPARSE_DISPATCH_THRESHOLD (small dense beats
  //     sparse overhead for tiny clusters), AND
  //   - bandwidth is significantly smaller than totalDim (otherwise
  //     banded Cholesky offers no asymptotic win over dense LU).
  if (c.sparseInfo === undefined) {
    c.sparseInfo = buildClusterSparseInfo(c);
    c.useSparse =
      c.totalDim >= SPARSE_DISPATCH_THRESHOLD &&
      c.sparseInfo.bandwidth < Math.floor(c.totalDim / 2);
  }

  const R = buildResidual(c);
  let result: NewtonResult | SparseNewtonResult;
  if (c.useSparse) {
    const Rsubset = buildResidualSubset(c);
    // Translate cluster-pinMask (per-slot) to sparse solver's free-
    // index list (handled inside dampedNewtonSparse from pinMask).
    result = dampedNewtonSparse(xs, R, Rsubset, c.m, c.pinMask, c.sparseInfo, {
      maxIters,
      tol,
    });
  } else {
    result = dampedNewton(xs, R, c.m, c.pinMask, {
      maxIters,
      tol,
    });
  }

  // Write back any cell whose final xs differs from its current value.
  for (const e of c.cellEntries) {
    const cur = e.cell.peek();
    const next = e.packer.unpack(xs, e.offset);
    if (!cellEquals(cur, next, e.packer)) {
      // biome-ignore lint/suspicious/noExplicitAny: write through generic Cell
      (e.cell as any).value = next;
    }
  }

  c.pinned.clear();

  // Update health.
  c.health.value = {
    residual: result.residual,
    iters: result.iters,
    converged: result.converged,
  };
  // Per-relation residual updates. R(xs, rScratch) stores the
  // *weighted* residual (entries × sqrt(weight)); the per-relation
  // signal exposes the UNWEIGHTED norm so consumers can flag actual
  // constraint violations, independent of strength.
  R(xs, c.rScratch);
  let off = 0;
  for (const entry of c.relations) {
    const rel = entry.rel;
    const w = rel._sqrtWeight;
    let s = 0;
    for (let i = 0; i < rel.m; i++) {
      const ri = w === 1 ? c.rScratch[off + i]! : c.rScratch[off + i]! / w;
      s += ri * ri;
    }
    rel._residualSig.value = Math.sqrt(s);
    off += rel.m;
  }
  void residualNorm;
}

/** Strict-or-component-wise equality for cell value writeback. */
function cellEquals(a: unknown, b: unknown, packer: Packer<unknown>): boolean {
  if (a === b) return true;
  if (packer.dim === 1) return false;
  // Composite: compare each slot via re-packing into a tmp.
  const tmpA = scratchA;
  const tmpB = scratchB;
  packer.pack(a, tmpA, 0);
  packer.pack(b, tmpB, 0);
  for (let i = 0; i < packer.dim; i++) {
    if (tmpA[i] !== tmpB[i]) return false;
  }
  return true;
}
const scratchA: number[] = new Array(8);
const scratchB: number[] = new Array(8);

// ─── Relation impl ───────────────────────────────────────────────────

const tol = 1e-9;
// Per-flush iteration budget. 64 is comfortable for most clusters
// we've benchmarked (4-bar warm-start: 1-2; equilateral: 3-4;
// strandbeest leg: 8-12; 4×4 mass-spring lattice: 12-20). Larger
// systems may need to span multiple flushes; the cluster's `health`
// signal exposes the residual so consumers can react to non-
// convergence.
const maxIters = 64;

class RelationImpl implements Relation {
  readonly cells: readonly Cell[];
  readonly m: number;
  readonly name: string;
  readonly residualFn: Residual;
  readonly residual: Read<number>;
  readonly satisfied: Read<boolean>;
  /** @internal — cluster pointer, updated on merge. */
  _cluster!: Cluster;
  _residualSig: Signal<number>;
  /** @internal — typed-values scratch: one slot per cell. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous values
  _argScratch: any[];
  _outScratch: number[];
  /** @internal — sqrt(weight); pre-multiplied so the hot path
   *  doesn't need to call Math.sqrt per evaluation. */
  _sqrtWeight: number;
  private _disposed = false;

  constructor(opts: RelateOpts) {
    this.cells = opts.cells;
    this.m = opts.m;
    this.name = opts.name ?? "anon";
    this.residualFn = opts.residual;
    this._argScratch = new Array<unknown>(opts.cells.length);
    this._outScratch = new Array<number>(opts.m);
    this._sqrtWeight = Math.sqrt(opts.weight ?? 1);
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
    // Note: doesn't currently split clusters when removing a
    // relation disconnects the graph.
  }
}

// ─── Public factory ──────────────────────────────────────────────────

export function relate(opts: RelateOpts): Relation {
  ensureSetup();
  const rel = new RelationImpl(opts);

  // Cluster identification: union-find over the cells.
  let target: Cluster | undefined;
  for (const cell of opts.cells) {
    const existing = cellToCluster.get(cell);
    if (existing === undefined) continue;
    if (target === undefined) target = existing;
    else if (target !== existing) target = mergeClusters(target, existing);
  }
  if (target === undefined) target = newCluster();

  // Add cells not already in target.
  for (const cell of opts.cells) {
    if (cellToCluster.get(cell) !== target) {
      const packer = packerOf(cell);
      target.cellEntries.push({ cell, packer, offset: target.totalDim });
      target.totalDim += packer.dim;
      cellToCluster.set(cell, target);
    }
  }
  resizeScratch(target);

  // Register relation against its cluster.
  const cellIdx = new Array<number>(opts.cells.length);
  for (let i = 0; i < opts.cells.length; i++) {
    const cell = opts.cells[i]!;
    cellIdx[i] = target.cellEntries.findIndex(e => e.cell === cell);
  }
  target.relations.push({ rel, cellIdx });
  target.m += opts.m;
  rel._cluster = target;
  // Invalidate cached sparsity info; it'll rebuild lazily on next solve.
  target.sparseInfo = undefined;
  target.useSparse = undefined;

  // Prime: solve immediately so the new relation's residual is up
  // to date.
  withSolverActive(() => solveCluster(target));
  dirtyClusters.delete(target);

  return rel;
}

// ─── Diagnostics ─────────────────────────────────────────────────────

export function clusterHealth(cell: Cell): Read<ClusterHealth> | undefined {
  const c = cellToCluster.get(cell);
  return c?.health;
}

export function clusterSize(cell: Cell): number {
  const c = cellToCluster.get(cell);
  return c?.cellEntries.length ?? 0;
}

export function _allClusters(): readonly Cluster[] {
  return Array.from(allClusters);
}

// ─── Hard pins ───────────────────────────────────────────────────────

/** Mark `cell` as hard-pinned at `value`. The cluster solver
 *  overrides this cell on every solve, regardless of user writes.
 *
 *  Polymorphic over cell type: for a Num pass `number | () => number`,
 *  for a Vec pass `{x, y} | () => {x, y}`, etc. The closure form
 *  re-reads the target on every solve (useful for reactive pins
 *  driven by an external signal). */
export function hardPin<T>(
  cell: Signal<T> & WritableBrand & { value: T },
  value: T | (() => T),
): () => void {
  ensureSetup();
  const fn: () => unknown = typeof value === "function" ? (value as () => unknown) : () => value;
  hardPinned.set(cell as Cell, fn);
  const cluster = cellToCluster.get(cell as Cell);
  if (cluster !== undefined) {
    withSolverActive(() => solveCluster(cluster));
    dirtyClusters.delete(cluster);
  } else {
    withSolverActive(() => {
      cell.value = fn() as T;
    });
  }
  return () => {
    hardPinned.delete(cell as Cell);
  };
}

export function isHardPinned(cell: Cell): boolean {
  return hardPinned.has(cell);
}

/** Backward-compat: register that pinning `source` should also pin
 *  `lensCells`. Useful for the field-lens-with-composite-parent
 *  pattern (cluster has Vec.x and Vec.y; user writes Vec.value).
 *
 *  Most users should pass the composite (Vec) as the cluster cell
 *  directly — this is no longer needed for the common case. Kept
 *  for the niche pattern of decomposing Vec/Box into per-axis Nums
 *  while still wanting composite-write pin propagation. */
export function trackLensSource(source: Signal<unknown>, lensCells: readonly Cell[]): void {
  ensureSetup();
  const existing = sourceToLensCells.get(source);
  if (existing !== undefined) {
    for (const c of lensCells) if (!existing.includes(c)) existing.push(c);
  } else {
    sourceToLensCells.set(source, lensCells.slice());
  }
}
