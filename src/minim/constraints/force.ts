// force.ts — abstract Force base class for AVBD constraints.
//
// A Force represents a single constraint binding one or more cells.
// Cells are referenced by integer id (`number`) into the solver's
// SOA buffers. Force methods read positions via
// `this.solver.positions[this.solver.offsets[id] + k]` and write
// derivatives into per-cell `J` / `HCols` buffers.
//
// The AVBD inner loop calls three things on each force:
//
//   1. `initialize()` — once per `prepare()`. Cache anything that
//      doesn't change within the step. Returns `false` if the
//      force should be removed (zero-stiffness, fractured, …).
//
//   2. `computeConstraint(alpha)` — at every primal/dual update.
//      Writes the m-vector `C` based on current cell positions.
//      For HARD constraints, applies stabilisation:
//          C(x) = C*(x) − α · C*(x⁻).
//
//   3. `computeDerivatives(cellIdx)` — at every primal update.
//      Writes the Jacobian column `J[cellIdx]` (size: rows × dim_i)
//      and the geometric-stiffness Hessian column-norms
//      `HCols[cellIdx]`. Each entry of `HCols[i][r * dim_i + k]`
//      is the L2 norm of column k of the per-row Hessian block —
//      used in the diagonally-lumped geometric stiffness term.
//
// `cellIdx` here means "this cell's index within `force.cells`",
// not the integer cell id. The Solver caches that index per
// (cell, force) at adjacency construction.

import type { Solver } from "./solver";

export const PENALTY_MIN = 1.0;
export const PENALTY_MAX = 1e9;

/** Hard cap on the augmented-Lagrangian multiplier `λ` per row.
 *
 *  Without a cap, the dual update `λ ← λ + ρ·C(x)` grows linearly
 *  per iteration whenever `C(x)` stays nonzero — i.e. whenever the
 *  constraint is *infeasible* in the current configuration. With
 *  enough iterations of an infeasible drag (user pulls a 4-bar
 *  joint outside its reachable workspace, two bodies pushed past
 *  each other under conflicting gaps, etc.), `λ` runs to `±∞` and
 *  the rhs in the local Newton solve overwhelms the lhs, sending
 *  positions to infinity within a handful of frames.
 *
 *  Capping at `1e9` (matching `PENALTY_MAX`) bounds the maximum
 *  "force" the constraint can apply, turning unsatisfiable
 *  constraints into a saturation rather than an explosion. The
 *  cap is symmetric (`±LAMBDA_MAX`) so equality constraints stay
 *  reachable from either side. */
export const LAMBDA_MAX = 1e9;

export abstract class Force {
  /** Solver this force belongs to. Subclasses read positions via
   *  `solver.positions[off + k]`, with `off` taken from
   *  `cellOffsets[ci]` (cached at construction). */
  readonly solver: Solver;
  /** Cell ids this force binds, in the order subclasses expect.
   *  `cells[ci]` is the cell-index-`ci` cell. */
  readonly cells: readonly number[];
  /** Per-cell-index starting offset into `solver.positions`,
   *  cached at construction. Solver offsets are append-only —
   *  once set, never moved — so caching is safe. Subclasses
   *  read positions as `solver.positions[cellOffsets[ci] + k]`,
   *  saving one array lookup per inner-loop access. */
  readonly cellOffsets: readonly number[];
  /** Per-cell-index dim, cached for the same reason as offsets. */
  readonly cellDims: readonly number[];
  /** Number of constraint scalar rows. */
  readonly rows: number;

  /** Current constraint values. Filled by `computeConstraint`. */
  readonly C: Float64Array;
  /** Constraint values at start of step — for hard-constraint
   *  stabilisation. Filled by `prepare()`. */
  readonly C0: Float64Array;
  /** Material stiffness per row. Use `Infinity` for a hard
   *  constraint (uses augmented-Lagrangian path). */
  readonly stiffness: Float64Array;
  /** Force lower bound per row (default `-Infinity`). */
  readonly fmin: Float64Array;
  /** Force upper bound per row (default `+Infinity`). */
  readonly fmax: Float64Array;
  /** Fracture threshold: `|λ| > fracture` disables the force. */
  readonly fracture: Float64Array;
  /** Current penalty parameter (warm-started, ramped via β). */
  readonly penalty: Float64Array;
  /** Lagrange multiplier for hard constraints (soft uses 0). */
  readonly lambda: Float64Array;
  /** Marks the force for removal at the next `solver.prepare()`.
   *  Set by `dispose()` (user) or by `_dualPass` (fracture). */
  disabled = false;

  /** Jacobian per cell-index: `J[ci]` is `rows × dim_{cells[ci]}`
   *  in row-major order. */
  readonly J: Float64Array[];
  /** Hessian column norms per cell-index. Same shape as `J[ci]`. */
  readonly HCols: Float64Array[];

  constructor(solver: Solver, cells: readonly number[], rows: number) {
    this.solver = solver;
    this.cells = cells;
    this.cellOffsets = cells.map(id => solver.offsets[id]!);
    this.cellDims = cells.map(id => solver.dims[id]!);
    this.rows = rows;
    this.C = new Float64Array(rows);
    this.C0 = new Float64Array(rows);
    this.stiffness = new Float64Array(rows).fill(Infinity);
    this.fmin = new Float64Array(rows).fill(-Infinity);
    this.fmax = new Float64Array(rows).fill(Infinity);
    this.fracture = new Float64Array(rows).fill(Infinity);
    this.penalty = new Float64Array(rows).fill(PENALTY_MIN);
    this.lambda = new Float64Array(rows);
    this.J = this.cellDims.map(d => new Float64Array(rows * d));
    this.HCols = this.cellDims.map(d => new Float64Array(rows * d));
    // Wire adjacency.
    for (let ci = 0; ci < cells.length; ci++) {
      solver._connectForce(this, cells[ci]!, ci);
    }
  }

  abstract initialize(): boolean;
  abstract computeConstraint(alpha: number): void;
  abstract computeDerivatives(cellIdx: number): void;

  /** Mark this force for removal. Takes effect on the next solver
   *  pass (the cluster's effect, or an explicit `solver.step()`).
   *  In a reactive `Cluster`, calling `cluster.update()` after
   *  `dispose()` materialises the change immediately. */
  dispose(): void {
    this.disabled = true;
  }

  /** True iff `stiffness[row]` is `Infinity` — solved via the
   *  augmented-Lagrangian path rather than penalty weighting.
   *  Hot paths inline the `=== Infinity` check directly. */
  isHard(row: number): boolean {
    return this.stiffness[row]! === Infinity;
  }
}
