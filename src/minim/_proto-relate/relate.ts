// relate.ts — first-class constraint relations over reactive cells.
//
// ─── Problem class we target ────────────────────────────────────────
//
// Continuous-domain nonlinear least-squares with optional convex
// inequality constraints, solved within a reactive substrate that
// supports dynamic topology change. Concretely:
//
//   IN-SCOPE:
//     - Real-valued cells (Num, Vec, Box, Color, any class with a
//       `traits.packer`).
//     - Equality constraints `f(x) = 0` (any smooth, finite-valued
//       residual function).
//     - Inequality constraints `g(x) ≥ 0` via penalty residuals
//       `max(0, -g(x))` — soft by default, escalatable via weight.
//     - Cassowary-style strength hierarchy (weighted LSQ, not slack-
//       variable simplex).
//     - Reactive topology: add/remove relations any time, solver
//       picks up the change next solve.
//     - Mixed-type clusters (Num + Vec + Box + …).
//     - Hard pins (engine-level), soft pins (residual), user pins
//       (per-batch automatic).
//
//   OUT-OF-SCOPE:
//     - Discrete or combinatorial domains (no integer programming,
//       no SAT, no graph isomorphism).
//     - Discontinuous residuals (subgradients OK; sharp jumps not).
//     - Disconnected feasible regions / global optimization.
//     - Worst-case real-time guarantees: we have soft frame budgets
//       (≤4ms / 8ms target at 50% of 125fps), no hard timing
//       contracts.
//     - Cassowary-style "hard inequality with strict satisfaction"
//       — those need slack variables + simplex, not LSQ. We instead
//       model them as REQUIRED-weighted penalty constraints, which
//       satisfy them very tightly but not exactly.
//
// ─── Behaviour ──────────────────────────────────────────────────────
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
  makeSparseScratch,
  type SparseInfo,
  type SparseNewtonResult,
  type SparseScratch,
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
  /** Hard-constraint mode. If `true`, the cluster solver enters an
   *  escalation outer loop after the standard Newton solve: any
   *  hard relation with residual > tol gets its effective weight
   *  bumped 10× and the cluster re-solves. Up to 5 escalations.
   *  After the cluster finishes, weights are restored.
   *
   *  This is a pragmatic substitute for true active-set / KKT-
   *  based hard inequality satisfaction. It works well when hard
   *  constraints are not in mutual contradiction (typical for
   *  layout / IK use cases). When contradictory, the highest-weight
   *  one wins per Newton iteration; the system degrades to LSQ
   *  best-fit at saturation.
   *
   *  Default: false. */
  hard?: boolean;
  /** Optional closed-form fast path applied BEFORE Newton on each
   *  cluster solve. The runtime calls this with the relation's
   *  current cell values and pinned-status flags; if the relation
   *  can solve itself given the current pin pattern (e.g., an
   *  invertible lens with one side pinned), it returns the cell
   *  updates to apply. Cells thus updated are marked pinned, so
   *  Newton skips them.
   *
   *  Peeling iterates: `lensNum(a, b, fwd, bwd)` followed by
   *  `lensNum(b, c, fwd2, bwd2)` cascades — pinning `a` derives
   *  `b`, which then derives `c`, all without Newton. When no
   *  more relations can solve themselves in closed form, control
   *  passes to Newton on the residual that remains.
   *
   *  The function is pure-ish: it should not mutate `vals` or
   *  `pinned`. It returns `undefined` when it has nothing to
   *  contribute. */
  fastPath?: FastPath;
  /** When `true`, the fast path is treated as a *corrector* rather
   *  than a *deriver*: it runs AFTER all derivers, can overwrite
   *  cells that derivers (or other correctors) have already
   *  written, and does NOT claim ownership of the cells it
   *  touches. Used for projections like `clamp` and `snapToGrid`
   *  that should compose with lens derivations.
   *
   *  Note: a corrector's edit doesn't propagate back through
   *  upstream lenses on the same iteration. If you need true
   *  bidirectional propagation, model the projection as a `lens`
   *  with a closed-form inverse instead. Default false. */
  fastPathCorrector?: boolean;
  /** Diagnostic name. */
  name?: string;
}

/** A closed-form solver for one relation. Returns the cell updates
 *  to apply (cellIdx into `cells`, plus the new value), or
 *  `undefined` when no fast path applies given the current pin
 *  pattern. */
export type FastPath = (
  vals: readonly unknown[],
  pinned: readonly boolean[],
) => readonly { cellIdx: number; value: unknown }[] | undefined;

/** Strength constants. Use as `weight: STRONG` to give a
 *  constraint priority over MEDIUM-strength ones.
 *
 *  HARD vs REQUIRED: REQUIRED is the standard Cassowary convention
 *  (1e9× weak); HARD is an additional 1000× stronger, intended for
 *  cases where you want near-perfect satisfaction even when other
 *  REQUIRED constraints contend. At HARD, Newton can suffer from
 *  ill-conditioning (the JᵀJ becomes nearly singular along the
 *  constraint's null direction) — for hard inequality satisfaction
 *  in particular, augmented-Lagrangian or active-set solvers are
 *  the principled answer. We provide HARD as a pragmatic shortcut. */
export const Strength = {
  WEAK: 1,
  MEDIUM: 1e3,
  STRONG: 1e6,
  REQUIRED: 1e9,
  HARD: 1e12,
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
  /** Persistent scratch buffers for the sparse path. Allocated
   *  lazily on first sparse solve; resized as the cluster grows. */
  sparseScratch?: SparseScratch;
  /** Whether any relation in this cluster requires the hard-
   *  constraint escalation outer loop. Maintained on add/dispose
   *  so the hot path skips escalation entirely when no relation
   *  is hard. */
  hasHardConstraints: boolean;
  /** Whether any relation in this cluster declares a `fastPath`.
   *  Maintained on add/dispose so the peeling pass is skipped
   *  entirely for clusters without invertibles. */
  hasFastPaths: boolean;
  /** Set once `ensureLensRelations` has scanned this cluster's
   *  cells for `_throughOf` lens-source pairs and injected the
   *  corresponding synthetic relations. Reset when topology changes. */
  lensRelationsScanned: boolean;
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

function ensureSetup(): void {
  if (pinHookInstalled) return;
  pinHookInstalled = true;
  setPinHook(sig => {
    const cluster = cellToCluster.get(sig as Cell);
    if (cluster !== undefined) {
      cluster.pinned.add(sig as Cell);
      dirtyClusters.add(cluster);
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

/** Approximate equality between typed cell values for fast-path
 *  idempotency checks. Handles scalars, `{x,y}` Vecs, and `{x,y,w,h}`
 *  Boxes. Other shapes fall back to strict reference equality. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const eps = 1e-12;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < eps;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    // Compare enumerable numeric keys; cheap structural compare.
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const akeys = Object.keys(ao);
    if (akeys.length !== Object.keys(bo).length) return false;
    for (const k of akeys) {
      const av = ao[k];
      const bv = bo[k];
      if (typeof av === "number" && typeof bv === "number") {
        if (Math.abs(av - bv) >= eps) return false;
      } else if (av !== bv) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** Closed-form peeling: iterate over relations with `fastPath`,
 *  asking each whether it can solve itself given the current pin
 *  state. Updates from a fast-path are written into `xScratch` and
 *  the affected slots are marked pinned. Cascades: pinning a cell
 *  may unlock the next relation.
 *
 *  Two-phase priority:
 *    Phase 1 — hard pins propagate. Lens chains rooted at hardPin
 *              cells derive their downstream cells, and those
 *              derivations override user-pins on the derived side.
 *              (Mirror of the engine's `Signal#through` behaviour:
 *              writing to a derived cell is overridden when the
 *              source is bound.)
 *    Phase 2 — user pins propagate, BUT only into still-free cells.
 *              Cells already derived (or hard-pinned) in phase 1
 *              are immutable here.
 *
 *  Returns `true` iff every cluster slot ends up pinned — Newton
 *  can then be skipped entirely. */
function applyFastPaths(c: Cluster): boolean {
  // Pre-compute cell-position lookups so per-relation queries are O(1).
  const cellToOffset = new Map<Cell, number>();
  const cellToDim = new Map<Cell, number>();
  // biome-ignore lint/suspicious/noExplicitAny: packer is opaque
  const cellToPacker = new Map<Cell, any>();
  for (const e of c.cellEntries) {
    cellToOffset.set(e.cell, e.offset);
    cellToDim.set(e.cell, e.packer.dim);
    cellToPacker.set(e.cell, e.packer);
  }

  // `fixed`: cells whose values are determined and may not change
  // (hard-pinned, or derived during peeling). User pins are NOT
  // automatically here — they're weaker.
  const fixed = new Set<Cell>();
  for (const e of c.cellEntries) {
    if (hardPinned.has(e.cell)) fixed.add(e.cell);
  }

  const peelPhase = (countAsPinned: (cell: Cell) => boolean, runCorrectors: boolean): void => {
    const localVals: unknown[] = [];
    const localPinned: boolean[] = [];
    let changed = true;
    let iter = 0;
    const MAX_PEEL_ITERS = 32;
    while (changed && iter < MAX_PEEL_ITERS) {
      changed = false;
      iter++;
      for (const entry of c.relations) {
        const rel = entry.rel;
        const fp = rel._fastPath;
        if (fp === undefined) continue;
        // Skip correctors during deriver passes, and vice versa.
        if (rel._fastPathCorrector !== runCorrectors) continue;
        const n = rel.cells.length;
        localVals.length = n;
        localPinned.length = n;
        for (let i = 0; i < n; i++) {
          const cell = rel.cells[i]!;
          const off = cellToOffset.get(cell);
          if (off === undefined) {
            localVals[i] = cell.peek();
            localPinned[i] = false;
            continue;
          }
          const packer = cellToPacker.get(cell);
          localVals[i] = packer ? packer.unpack(c.xScratch, off) : c.xScratch[off];
          localPinned[i] = countAsPinned(cell);
        }
        const updates = fp(localVals, localPinned);
        if (!updates || updates.length === 0) continue;
        for (const u of updates) {
          const cell = rel.cells[u.cellIdx];
          if (!cell) continue;
          // Derivers respect existing fixed claims (no overwrites);
          // correctors are allowed to overwrite derivations BUT
          // hard pins are sacred either way.
          if (hardPinned.has(cell)) continue;
          if (!rel._fastPathCorrector && fixed.has(cell)) continue;
          const off = cellToOffset.get(cell);
          if (off === undefined) continue;
          const dim = cellToDim.get(cell)!;
          const packer = cellToPacker.get(cell);
          // Idempotency check: skip if the value would be unchanged
          // (within a tight tolerance). This is what makes corrector
          // loops terminate.
          const cur = packer ? packer.unpack(c.xScratch, off) : c.xScratch[off];
          if (sameValue(cur, u.value)) continue;
          if (packer) {
            packer.pack(u.value, c.xScratch, off);
          } else {
            c.xScratch[off] = u.value as number;
          }
          for (let k = 0; k < dim; k++) c.pinMask[off + k] = true;
          if (!rel._fastPathCorrector) fixed.add(cell);
          changed = true;
        }
      }
    }
  };

  // Derivation passes:
  //   Phase 1 — only hard pins count as sources.
  peelPhase(cell => fixed.has(cell), false);
  //   Phase 2 — user pins also act as sources.
  peelPhase(cell => fixed.has(cell) || c.pinned.has(cell), false);
  // Correction pass: clamps / snaps run AFTER all derivations have
  // settled. Correctors may overwrite derived values.
  peelPhase(cell => fixed.has(cell) || c.pinned.has(cell), true);

  // Final pinMask reconciliation. fixed cells were already
  // pinMask=true; user-pinned cells were already true from
  // solveCluster's pack step. Nothing to do here.
  for (let i = 0; i < c.totalDim; i++) {
    if (!c.pinMask[i]) return false;
  }
  return true;
}

/** Auto-injection of synthetic lens relations.
 *
 *  When a cell `b` is created via `a.through(fwd, bwd)`, the engine
 *  records that relationship on `b._throughOf`. If both `a` and
 *  `b` end up in the same cluster, the cluster solver needs to
 *  know they're linked — otherwise Newton's FD perturbation moves
 *  their slots independently and the residual sees inconsistent
 *  state.
 *
 *  This pass scans the cluster's cells once per topology change.
 *  For each lens cell whose source is also in the cluster, it
 *  injects a synthetic relation:
 *
 *      cells:   [source, lens]
 *      residual: pack(fwd(source)) - pack(lens)   // dim entries
 *      fastPath: source pinned → derive lens via fwd
 *                lens pinned   → derive source via bwd
 *
 *  Almost always solves in zero Newton iterations via the fastPath. */
function ensureLensRelations(c: Cluster): void {
  if (c.lensRelationsScanned) return;
  c.lensRelationsScanned = true;
  // Build a fast index: cell → entry-index in cluster.cellEntries.
  const cellIdxMap = new Map<Cell, number>();
  for (let i = 0; i < c.cellEntries.length; i++) {
    cellIdxMap.set(c.cellEntries[i]!.cell, i);
  }
  for (let i = 0; i < c.cellEntries.length; i++) {
    const e = c.cellEntries[i]!;
    // biome-ignore lint/suspicious/noExplicitAny: probing engine internals
    const tof = (e.cell as any)._throughOf as
      | { parent: Cell; fwd: (v: unknown) => unknown; bwd: (v: unknown) => unknown }
      | undefined;
    if (!tof) continue;
    const parent = tof.parent;
    const parentIdx = cellIdxMap.get(parent);
    if (parentIdx === undefined) continue;
    // Don't double-inject: skip if the user already wrote a relation
    // over the same (parent, lens) pair (rare; tolerated).
    const alreadyExplicit = c.relations.some(
      r =>
        r.rel.cells.length === 2 &&
        ((r.rel.cells[0] === parent && r.rel.cells[1] === e.cell) ||
          (r.rel.cells[0] === e.cell && r.rel.cells[1] === parent)),
    );
    if (alreadyExplicit) continue;

    // Build the synthetic relation. Use the lens's packer to get
    // dim and pack/unpack — handles Num, Vec, Box uniformly.
    const packer = e.packer;
    const dim = packer.dim;
    const fwd = tof.fwd;
    const bwd = tof.bwd;
    // Scratch buffers for residual computation. Captured in closure.
    const expectedFlat = new Array<number>(dim);
    const actualFlat = new Array<number>(dim);

    const synth = new RelationImpl({
      name: "auto-lens",
      cells: [parent, e.cell],
      residual: ([va, vb], out) => {
        const expectedVal = fwd(va);
        packer.pack(expectedVal, expectedFlat, 0);
        packer.pack(vb, actualFlat, 0);
        for (let k = 0; k < dim; k++) out[k] = actualFlat[k]! - expectedFlat[k]!;
      },
      m: dim,
      fastPath: (vals, pinned) => {
        if (pinned[0] && !pinned[1]) {
          return [{ cellIdx: 1, value: fwd(vals[0]) }];
        }
        if (pinned[1] && !pinned[0]) {
          return [{ cellIdx: 0, value: bwd(vals[1]) }];
        }
        return undefined;
      },
    });
    // Synthetic relations don't set _cluster (relate() factory does
    // that for user relations). Set it manually here.
    synth._cluster = c;
    c.relations.push({ rel: synth, cellIdx: [parentIdx, i] });
    c.m += dim;
    c.hasFastPaths = true;
  }
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
    hasHardConstraints: false,
    hasFastPaths: false,
    lensRelationsScanned: false,
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
  if (b.hasHardConstraints) a.hasHardConstraints = true;
  if (b.hasFastPaths) a.hasFastPaths = true;
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
): (xs: readonly number[], which: readonly number[], out: ResidualOut) => void {
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

/** Numeric output buffer used by residual functions — accepts both
 *  `number[]` (dense path) and `Float64Array` (sparse path). The
 *  residual writes via indexed assignment which works for both. */
type ResidualOut = number[] | Float64Array;

function buildResidual(c: Cluster): (xs: readonly number[], out: ResidualOut) => void {
  const rels = c.relations;
  const cellEntries = c.cellEntries;
  const valsScratch = c.valsScratch;
  return (xs, out) => {
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
  // Auto-inject `_throughOf` lens relations BEFORE the early-return
  // check — they may be the only constraints if user gave us cells
  // without an explicit residual.
  ensureLensRelations(c);
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

  // Closed-form peeling. For relations that declare a `fastPath`,
  // ask "given the current pin pattern, can you solve yourself?".
  // Iterate until quiescent: a relation that derives a cell makes
  // it pinned, which may unlock the next relation's fast path.
  // After this loop, Newton runs on what's left.
  let peeledAllPinned = false;
  if (c.hasFastPaths) {
    peeledAllPinned = applyFastPaths(c);
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
  const runNewton = (): NewtonResult | SparseNewtonResult => {
    if (peeledAllPinned) {
      // Every cell got pinned by closed-form peeling — nothing for
      // Newton to do. Compute the residual once for health reporting
      // and return a converged-by-construction result.
      R(xs, c.rScratch);
      let s = 0;
      for (let i = 0; i < c.m; i++) {
        const v = (c.rScratch as number[])[i]!;
        s += v * v;
      }
      const norm = Math.sqrt(s);
      return { residual: norm, iters: 0, converged: norm < tol, lambda: 0 };
    }
    if (c.useSparse) {
      const Rsubset = buildResidualSubset(c);
      if (c.sparseScratch === undefined) c.sparseScratch = makeSparseScratch();
      return dampedNewtonSparse(xs, R, Rsubset, c.m, c.pinMask, c.sparseInfo!, c.sparseScratch, {
        maxIters,
        tol,
      });
    }
    return dampedNewton(xs, R, c.m, c.pinMask, { maxIters, tol });
  };
  result = runNewton();

  // Hard-constraint escalation outer loop. After Newton converges,
  // check each `hard` relation's residual; if any exceeds tol, bump
  // its weight 10× and re-solve. Up to 5 escalations. After we're
  // done (converged or budget exhausted), restore base weights.
  if (c.hasHardConstraints) {
    for (let escalation = 0; escalation < 5; escalation++) {
      let anyViolation = false;
      // Compute per-relation residual using current weights.
      R(xs, c.rScratch);
      let off = 0;
      for (const entry of c.relations) {
        const rel = entry.rel;
        if (rel._isHard) {
          const w = rel._sqrtWeight;
          let s = 0;
          for (let i = 0; i < rel.m; i++) {
            const ri = w === 1 ? c.rScratch[off + i]! : c.rScratch[off + i]! / w;
            s += ri * ri;
          }
          if (Math.sqrt(s) > tol * 10) {
            // Hard violation — escalate this relation's weight.
            rel._sqrtWeight *= Math.sqrt(10);
            anyViolation = true;
          }
        }
        off += rel.m;
      }
      if (!anyViolation) break;
      result = runNewton();
    }
    // Restore base weights so subsequent solves see the user's
    // declared weight, not the inflated one. (The next solve may
    // have a different pin set and its own escalation needs.)
    for (const entry of c.relations) {
      entry.rel._sqrtWeight = entry.rel._baseSqrtWeight;
    }
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
   *  doesn't need to call Math.sqrt per evaluation. May be
   *  temporarily inflated by the escalation outer loop for hard
   *  constraints, then restored. */
  _sqrtWeight: number;
  /** @internal — base sqrt(weight); preserved across escalation. */
  _baseSqrtWeight: number;
  /** @internal — true iff this is a hard constraint (escalates
   *  weight if residual > tol after solve). */
  _isHard: boolean;
  /** @internal — optional closed-form fast path. */
  _fastPath: FastPath | undefined;
  /** @internal — true iff fastPath is a corrector (overwrites). */
  _fastPathCorrector: boolean;
  private _disposed = false;

  constructor(opts: RelateOpts) {
    this.cells = opts.cells;
    this.m = opts.m;
    this.name = opts.name ?? "anon";
    this.residualFn = opts.residual;
    this._argScratch = new Array<unknown>(opts.cells.length);
    this._outScratch = new Array<number>(opts.m);
    this._baseSqrtWeight = Math.sqrt(opts.weight ?? 1);
    this._sqrtWeight = this._baseSqrtWeight;
    this._isHard = opts.hard ?? false;
    this._fastPath = opts.fastPath;
    this._fastPathCorrector = opts.fastPathCorrector ?? false;
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
    // Invalidate cached sparsity info — the constraint structure
    // changed. Sparse path will rebuild on next solve.
    c.sparseInfo = undefined;
    c.useSparse = undefined;
    c.lensRelationsScanned = false;
    // Recompute the hard-constraint flag (may have been the only
    // hard relation in this cluster).
    if (this._isHard) {
      c.hasHardConstraints = c.relations.some(e => e.rel._isHard);
    }
    if (this._fastPath !== undefined) {
      c.hasFastPaths = c.relations.some(e => e.rel._fastPath !== undefined);
    }
    // Note: doesn't currently split clusters when removing a
    // relation disconnects the graph. Disconnected components stay
    // in one cluster — correctness is preserved (block-diagonal
    // JᵀJ solves correctly), but perf is suboptimal. Splitting on
    // dispose is a future optimisation.
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
  if (rel._isHard) target.hasHardConstraints = true;
  if (rel._fastPath !== undefined) target.hasFastPaths = true;
  // Invalidate cached sparsity info; it'll rebuild lazily on next solve.
  target.sparseInfo = undefined;
  target.useSparse = undefined;
  // Cells changed → re-scan for `_throughOf` lens relationships.
  target.lensRelationsScanned = false;

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

/** List the cells in `cell`'s cluster (transitive closure of any
 *  relation that touches `cell`). Returns an empty array if the
 *  cell isn't in any cluster. */
export function clusterCells(cell: Cell): readonly Cell[] {
  const c = cellToCluster.get(cell);
  if (!c) return [];
  return c.cellEntries.map(e => e.cell);
}

/** List the relations in `cell`'s cluster. Includes auto-injected
 *  `_throughOf` lens relations — these are tagged `name: "auto-lens"`. */
export function clusterRelations(cell: Cell): readonly Relation[] {
  const c = cellToCluster.get(cell);
  if (!c) return [];
  return c.relations.map(e => e.rel);
}

/** Diagnostic snapshot of a cluster's sparsity structure. Used by
 *  benchmarks to confirm that the sparse path is reachable for a
 *  given topology, and that RCM is delivering its expected
 *  bandwidth reduction. Returns `undefined` if the cell isn't in
 *  any cluster yet. */
export function _clusterSparseInfo(cell: Cell):
  | {
      totalSlots: number;
      totalNNZ: number;
      bandwidth: number;
      useSparse: boolean | undefined;
    }
  | undefined {
  const c = cellToCluster.get(cell);
  if (!c) return undefined;
  if (!c.sparseInfo) {
    c.sparseInfo = buildClusterSparseInfo(c);
    c.useSparse =
      c.totalDim >= SPARSE_DISPATCH_THRESHOLD &&
      c.sparseInfo.bandwidth < Math.floor(c.totalDim / 2);
  }
  return {
    totalSlots: c.sparseInfo.totalSlots,
    totalNNZ: c.sparseInfo.totalNNZ,
    bandwidth: c.sparseInfo.bandwidth,
    useSparse: c.useSparse,
  };
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
