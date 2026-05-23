// force.ts — abstract Force base class for AVBD constraints.
//
// A Force represents a single constraint binding one or more cells.
// The user-facing constraint factories (`distance`, `lens`, `eq`,
// `clamp`, …) produce concrete Force subclasses.
//
// The AVBD inner loop calls three things on each force:
//
//   1. `initialize()` — once per timestep, before any iteration.
//      Caches anything that doesn't change within the step
//      (rest-state Jacobians, C(x⁻) for stabilisation, …). Returns
//      `false` if the force should be removed (e.g., fractured).
//
//   2. `computeConstraint(alpha)` — at every primal and dual update.
//      Writes the m-vector `C` based on the current cell positions.
//      For HARD constraints, applies stabilisation:
//          C(x) = C*(x) − α · C*(x⁻)
//      where `C*` is the un-stabilised constraint and α is the
//      stabilisation parameter (paper §3.6, eq. 18).
//
//   3. `computeDerivatives(cellIdx)` — at every primal update.
//      Writes the Jacobian column J[cellIdx] (size: rows × dim_cell)
//      and the geometric-stiffness-friendly Hessian column-norms
//      `HCols[cellIdx]` (size: rows × dim_cell). Each entry of
//      `HCols[cellIdx][row * dim + k]` is the L2 norm of column k
//      of the per-row Hessian block for that cell — used in the
//      diagonally-lumped geometric stiffness term (paper §3.5).
//
// Per-row state managed by AVBD itself (filled in by Solver):
//
//   C0        — C(x⁻); cached at `initialize` time for stabilisation
//   stiffness — material stiffness; ∞ for hard constraints
//   fmin/fmax — force bounds (inequalities, joint limits)
//   fracture  — magnitude beyond which the force breaks (∞ for none)
//   penalty   — current penalty parameter (k in the paper);
//               ramps up via `k ← k + β|C|` (paper eq. 12, 16)
//   lambda    — Lagrange multiplier (only used for hard constraints)
//   C         — current constraint values (filled by computeConstraint)
//   J[i]      — Jacobian wrt cell i (filled by computeDerivatives)
//   HCols[i]  — Hessian column norms wrt cell i (same)
//
// The solver doesn't try to be fully generic over `rows` — instead
// each Force knows how many rows it has and pre-allocates buffers.

import type { Cell } from "./cell";

export const PENALTY_MIN = 1.0;
export const PENALTY_MAX = 1e9;

export abstract class Force {
  /** Cells this force binds. */
  readonly cells: readonly Cell[];
  /** Number of constraint scalar rows. */
  readonly rows: number;

  /** Current constraint values. Filled by `computeConstraint`. */
  C: Float64Array;
  /** Constraint values at start of timestep — for hard-constraint
   *  stabilisation. Filled by `initialize`. */
  C0: Float64Array;
  /** Material stiffness per row. Use `Infinity` for a hard
   *  constraint (uses augmented-Lagrangian path). */
  stiffness: Float64Array;
  /** Force lower bound per row (default `-Infinity`). */
  fmin: Float64Array;
  /** Force upper bound per row (default `+Infinity`). */
  fmax: Float64Array;
  /** Fracture threshold: |λ| > fracture disables the force. */
  fracture: Float64Array;
  /** Current penalty parameter (warm-started, ramped via β). */
  penalty: Float64Array;
  /** Lagrange multiplier for hard constraints. Soft uses 0. */
  lambda: Float64Array;
  /** Whether the force is disabled (fractured / removed). */
  disabled = false;
  /** Cached `isHard(r)` per row — avoids `Number.isFinite` in the
   *  hot loop. Maintained by mutating `stiffness` callers. */
  hard: Uint8Array;

  /** Jacobian per cell. `J[cellIdx]` is a flat `rows × dim_cell`
   *  buffer in row-major order: `J[i][r * dim + k] = ∂C[r] / ∂cell[i][k]`.
   *  Solver allocates this once per force at construction. */
  J: Float64Array[];
  /** Per-cell Hessian column norms, used for the diagonally-lumped
   *  geometric stiffness term `G = diag(‖H_{:,0}‖, ‖H_{:,1}‖, …) · |f|`
   *  (paper §3.5). `HCols[cellIdx][r * dim + k]` is the norm of
   *  column k of the row-r Hessian block for cell i. Most
   *  constraints are linear in their cells (so H = 0); those skip
   *  this. */
  HCols: Float64Array[];

  constructor(cells: readonly Cell[], rows: number) {
    this.cells = cells;
    this.rows = rows;
    this.C = new Float64Array(rows);
    this.C0 = new Float64Array(rows);
    this.stiffness = new Float64Array(rows).fill(Infinity);
    this.fmin = new Float64Array(rows).fill(-Infinity);
    this.fmax = new Float64Array(rows).fill(Infinity);
    this.fracture = new Float64Array(rows).fill(Infinity);
    this.penalty = new Float64Array(rows).fill(PENALTY_MIN);
    this.lambda = new Float64Array(rows);
    this.J = cells.map(c => new Float64Array(rows * c.dim));
    this.HCols = cells.map(c => new Float64Array(rows * c.dim));
    this.hard = new Uint8Array(rows).fill(1); // stiffness defaults to ∞
    // Wire up adjacency. Each cell records its index within
    // `force.cells` so the solver's hot loop can avoid an O(n)
    // indexOf scan per cell-visit-per-iteration.
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci]!;
      c.forces.push(this);
      c.forceCellIdx.push(ci);
    }
  }

  /** Refresh `hard` flags from `stiffness`. Call after mutating
   *  stiffness (most user code never does). */
  refreshHardFlags(): void {
    for (let r = 0; r < this.rows; r++) {
      this.hard[r] = Number.isFinite(this.stiffness[r]!) ? 0 : 1;
    }
  }

  /** Cache per-step constants. Called once at the start of each
   *  timestep. Return `false` to indicate the force should be
   *  removed from the solver (e.g., zero-stiffness, fractured). */
  abstract initialize(): boolean;

  /** Write `C` based on current cell positions. */
  abstract computeConstraint(alpha: number): void;

  /** Write `J[cellIdx]` and `HCols[cellIdx]`. */
  abstract computeDerivatives(cellIdx: number): void;

  /** Disable this force. Solver removes it on next initialize pass. */
  disable(): void {
    this.disabled = true;
  }

  /** True iff stiffness for the given row is infinite (hard
   *  constraint → augmented-Lagrangian path). Reads the cached
   *  `hard` flag — refresh it via `refreshHardFlags` after
   *  mutating `stiffness`. */
  isHard(row: number): boolean {
    return this.hard[row] === 1;
  }
}
