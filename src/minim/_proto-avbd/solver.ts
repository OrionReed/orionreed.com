// solver.ts — Augmented Vertex Block Descent solver core.
//
// SOA layout: per-cell state lives in packed `Float64Array` /
// typed-array buffers indexed by integer cell id (`number`). No
// per-cell heap allocation; the hot loop streams contiguous
// memory and the JIT keeps stable hidden classes.
//
// Cells are integer handles returned by `addCell(dim, init?)`.
// Forces store `cells: number[]` and read positions via
// `solver.positions[solver.offsets[id] + k]`. The reactive layer
// (`reactive.ts`) maps signals to cell ids and back.
//
// The solver answers the time-free question: "given an inertial
// anchor `y` and constraints, find `x`." Time-stepping (velocity,
// dt, gravity) is `Simulation`'s job — see simulation.ts.

import { type Pack, requirePack, type Signal } from "../signals";
import type { Force } from "./force";
import { PENALTY_MAX, PENALTY_MIN } from "./force";
import { clamp, solveSPD } from "./linalg";

export interface SolverOpts {
  /** Number of primal+dual iterations per solve. Default 10. */
  iterations?: number;
  /** Stabilisation parameter α ∈ [0, 1]. `0` (default) = full
   *  error correction; positive α delays correction across
   *  multiple steps (`C(x) − α·C(x⁻)`), useful for physics. */
  alpha?: number;
  /** Penalty ramp parameter β. Default 1e5 (paper recommends
   *  [1, 1000]; 1e5 worked for the reference 2D demo). */
  beta?: number;
  /** Warm-start decay γ ∈ [0, 1). Default 0.99. */
  gamma?: number;
  /** Initial buffer capacity in scalar slots. Buffers grow by
   *  doubling when needed; seeding a generous capacity avoids
   *  the cost of early reallocations. Default 64. */
  initialCapacity?: number;
}

const TINY = 1e-14;

/** Remove element at `idx` by swapping in the last element. O(1).
 *  Caller must not rely on element ordering. */
function swapPop<T>(arr: T[], idx: number): void {
  if (idx < 0 || idx >= arr.length) return;
  const last = arr.length - 1;
  if (idx !== last) arr[idx] = arr[last]!;
  arr.pop();
}

export class Solver {
  iterations: number;
  alpha: number;
  beta: number;
  gamma: number;

  // ─── Per-cell SOA state ──────────────────────────────────────────
  /** Packed cell positions. `positions[offsets[id] + k]` reads the
   *  k-th component of cell `id`. Solver writes here directly. */
  positions: Float64Array;
  /** Packed cell positions at start of step (`x⁻`). */
  initials: Float64Array;
  /** Packed warm-start anchors (`y`). Defaults to `initials`;
   *  `Simulation` overwrites for physics. */
  inertials: Float64Array;
  /** Inertia-term weight per cell (`mass`). `0` = kinematic /
   *  pinned (primal update is skipped, value stays put). */
  masses: Float64Array;
  /** Per-cell dim. Stored as Uint8 since dims are small. */
  dims: Uint8Array;
  /** Start of each cell within `positions`. Cumulative sum of
   *  `dims`. Stored as Uint32 for size up to 4G slots. */
  offsets: Uint32Array;

  // ─── Adjacency ───────────────────────────────────────────────────
  /** Per-cell list of incident forces. Order doesn't matter
   *  (solver iterates all). */
  cellForces: Force[][] = [];
  /** Parallel array: `cellForceCellIdx[id][k]` is this cell's
   *  index within `cellForces[id][k].cells`. Avoids an O(n)
   *  `indexOf` per cell-visit-per-iteration. */
  cellForceCellIdx: number[][] = [];

  // ─── Forces ──────────────────────────────────────────────────────
  private readonly _forces: Force[] = [];
  /** Read-only view of registered forces. */
  get forces(): readonly Force[] {
    return this._forces;
  }

  // ─── Internal ────────────────────────────────────────────────────
  private _capacity: number; // current buffer length in scalar slots
  private _totalDof = 0; // current used scalar slots
  private _cellCount = 0;
  private _maxDim = 0;
  private _lhs = new Float64Array(0); // dim×dim local Newton scratch
  private _rhs = new Float64Array(0);

  /** Number of cells currently registered. */
  get cellCount(): number {
    return this._cellCount;
  }

  constructor(opts: SolverOpts = {}) {
    this.iterations = opts.iterations ?? 10;
    this.alpha = opts.alpha ?? 0;
    this.beta = opts.beta ?? 1e5;
    this.gamma = opts.gamma ?? 0.99;
    const cap = opts.initialCapacity ?? 64;
    this._capacity = cap;
    this.positions = new Float64Array(cap);
    this.initials = new Float64Array(cap);
    this.inertials = new Float64Array(cap);
    // dims/offsets/masses are sized per-cell, not per-scalar.
    this.dims = new Uint8Array(16);
    this.offsets = new Uint32Array(16);
    this.masses = new Float64Array(16);
  }

  /** Add a cell with the given dim. Optionally seed initial value
   *  via `init`. Returns the cell's integer id. */
  addCell(dim: number, init?: ArrayLike<number>): number {
    const id = this._cellCount;
    // Grow per-cell arrays if needed.
    if (id >= this.dims.length) this._growCellArrays();
    // Grow scalar buffers if needed.
    if (this._totalDof + dim > this._capacity) this._growScalarBuffers(dim);

    const off = this._totalDof;
    this.dims[id] = dim;
    this.offsets[id] = off;
    this.masses[id] = 1;
    if (init) {
      for (let k = 0; k < dim; k++) {
        const v = init[k] ?? 0;
        this.positions[off + k] = v;
        this.initials[off + k] = v;
        this.inertials[off + k] = v;
      }
    } else {
      // Already zero-initialised by Float64Array, but make it
      // explicit for clarity / future-proofing if we ever switch
      // to a non-zero-init store.
      for (let k = 0; k < dim; k++) {
        this.positions[off + k] = 0;
        this.initials[off + k] = 0;
        this.inertials[off + k] = 0;
      }
    }
    this._totalDof += dim;
    this._cellCount++;
    this.cellForces.push([]);
    this.cellForceCellIdx.push([]);

    if (dim > this._maxDim) {
      this._maxDim = dim;
      this._lhs = new Float64Array(dim * dim);
      this._rhs = new Float64Array(dim);
    }
    return id;
  }

  addForce(force: Force): void {
    this._forces.push(force);
  }

  removeForce(force: Force): void {
    swapPop(this._forces, this._forces.indexOf(force));
    const cells = force.cells;
    for (let ci = 0; ci < cells.length; ci++) {
      const cid = cells[ci]!;
      const list = this.cellForces[cid]!;
      const idxList = this.cellForceCellIdx[cid]!;
      const k = list.indexOf(force);
      if (k < 0) continue;
      swapPop(list, k);
      swapPop(idxList, k);
    }
  }

  /** @internal — for `Force` constructors to wire the cell ↔ force
   *  adjacency. Subclasses should not call this directly. */
  _connectForce(force: Force, cellId: number, cellIndex: number): void {
    this.cellForces[cellId]!.push(force);
    this.cellForceCellIdx[cellId]!.push(cellIndex);
  }

  // ─── Signal binding (reactive integration) ──────────────────────
  //
  // `bind(sig)` registers a `Signal` (typed value class with the
  // `pack` trait) and returns its cell id. Repeat calls return the
  // same id. Mass starts at 1; flip to 0 to pin (or use the
  // `pin(sig)` helper from `reactive.ts`). The signal layer
  // handles propagation; the reactive driver (installed lazily by
  // `reactive.ts` when first invoked) reads/writes signals at
  // step boundaries.

  // biome-ignore lint/suspicious/noExplicitAny: see Bindable in constraints.ts
  private readonly _sigToCell = new Map<Signal<any>, number>();
  /** @internal — reactive layer reads this to drive sync. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  readonly _cellToBinding: { sig: Signal<any>; pack: Pack<any> }[] = [];

  /** Bind a reactive `Signal` (any value class declaring the `pack`
   *  trait — `Num`, `Vec`, `Box`, `Color`, …) and return its cell
   *  id. Repeat calls return the same id. */
  // biome-ignore lint/suspicious/noExplicitAny: see Bindable
  bind(sig: Signal<any>): number {
    const existing = this._sigToCell.get(sig);
    if (existing !== undefined) return existing;
    const pack = requirePack(sig as never) as Pack<unknown>;
    const init = new Float64Array(pack.dim);
    pack.read(sig.peek(), init, 0);
    const id = this.addCell(pack.dim, init);
    this._sigToCell.set(sig, id);
    this._cellToBinding[id] = { sig, pack };
    // Lazy-install the reactive driver on the first bind. For
    // subsequent binds, just `invalidate()` the existing driver:
    // it'll re-run on the next flush, re-iterate the bindings
    // map, and pick up the new signal as a dependency. This keeps
    // the construction cost O(N) (one bind = one map insert +
    // one invalidate) rather than O(N²) for re-installing.
    if (this._reactiveHandle === undefined) {
      installReactiveDriver(this);
    } else {
      this._reactiveHandle.invalidate();
    }
    return id;
  }

  /** Read cell `id`'s position into `out` (or a fresh array). */
  read(id: number, out: number[] = []): number[] {
    const off = this.offsets[id]!;
    const dim = this.dims[id]!;
    for (let k = 0; k < dim; k++) out[k] = this.positions[off + k]!;
    out.length = dim;
    return out;
  }

  /** Write cell `id`'s position from `value`. */
  write(id: number, value: ArrayLike<number>): void {
    const off = this.offsets[id]!;
    const dim = this.dims[id]!;
    for (let k = 0; k < dim; k++) this.positions[off + k] = value[k] ?? 0;
  }

  /** Get the mass of cell `id` (`0` = pinned). */
  massOf(id: number): number {
    return this.masses[id]!;
  }

  /** Set the mass of cell `id`. */
  setMass(id: number, m: number): void {
    this.masses[id] = m;
  }

  /** Convenience: `prepare()` + `solve(1)`. The default static-
   *  editing step. For physics, drive via `Simulation.tick(dt)`. */
  step(): void {
    this.prepare();
    this.solve(1);
  }

  /** Snapshot positions (initials = positions), set inertial =
   *  positions, and warm-start each force. After this, callers may
   *  overwrite `inertials` (e.g. `Simulation` adds extrapolation)
   *  before invoking `solve(dt)`. */
  prepare(): void {
    // Force initialisation + warm-start.
    for (let fi = this._forces.length - 1; fi >= 0; fi--) {
      const f = this._forces[fi]!;
      if (f.disabled) {
        this.removeForce(f);
        continue;
      }
      if (!f.initialize()) {
        this.removeForce(f);
        continue;
      }
      f.computeConstraint(0);
      for (let r = 0; r < f.rows; r++) f.C0[r]! = f.C[r]!;
      for (let r = 0; r < f.rows; r++) {
        f.lambda[r]! *= this.gamma;
        f.penalty[r]! = clamp(f.penalty[r]! * this.gamma, PENALTY_MIN, PENALTY_MAX);
        const k = f.stiffness[r]!;
        if (Number.isFinite(k) && f.penalty[r]! > k) f.penalty[r]! = k;
      }
    }
    // Cell warm-start: y = x⁻ by default.
    const N = this._totalDof;
    for (let i = 0; i < N; i++) {
      this.initials[i] = this.positions[i]!;
      this.inertials[i] = this.positions[i]!;
    }
  }

  /** Run the iteration loop using the current `inertials` as the
   *  warm-start anchor. `dt` scales the inertia term `m / dt²`. */
  solve(dt: number = 1): void {
    const inv_dt2 = 1 / (dt * dt);
    for (let it = 0; it < this.iterations; it++) {
      this._primalSweep(this.alpha, inv_dt2);
      this._dualPass(this.alpha);
    }
  }

  /** Compute `‖C‖` for diagnostics. */
  residualNorm(): number {
    let s = 0;
    for (const f of this._forces) {
      if (f.disabled) continue;
      f.computeConstraint(0);
      for (let r = 0; r < f.rows; r++) s += f.C[r]! * f.C[r]!;
    }
    return Math.sqrt(s);
  }

  // ─── Inner loops ─────────────────────────────────────────────────

  /** Forward Gauss-Seidel sweep over cells. Hot path. */
  private _primalSweep(currentAlpha: number, inv_dt2: number): void {
    const lhs = this._lhs;
    const rhs = this._rhs;
    const positions = this.positions;
    const inertials = this.inertials;
    const masses = this.masses;
    const dims = this.dims;
    const offsets = this.offsets;
    const cellForces = this.cellForces;
    const cellForceCellIdx = this.cellForceCellIdx;
    const N = this._cellCount;

    for (let cellI = 0; cellI < N; cellI++) {
      const m = masses[cellI]!;
      if (m <= 0) continue;
      const dim = dims[cellI]!;
      const off = offsets[cellI]!;
      const massInvDt2 = m * inv_dt2;

      // Initialise lhs = M / dt² · I, rhs = M / dt² · (x − y).
      if (dim === 2) {
        lhs[0]! = massInvDt2;
        lhs[1]! = 0;
        lhs[2]! = 0;
        lhs[3]! = massInvDt2;
        rhs[0]! = massInvDt2 * (positions[off]! - inertials[off]!);
        rhs[1]! = massInvDt2 * (positions[off + 1]! - inertials[off + 1]!);
      } else {
        for (let i = 0; i < dim * dim; i++) lhs[i]! = 0;
        for (let i = 0; i < dim; i++) lhs[i * dim + i]! = massInvDt2;
        for (let k = 0; k < dim; k++) {
          rhs[k]! = massInvDt2 * (positions[off + k]! - inertials[off + k]!);
        }
      }

      // Accumulate force contributions.
      const forceList = cellForces[cellI]!;
      const forceCiList = cellForceCellIdx[cellI]!;
      const flen = forceList.length;
      for (let fi = 0; fi < flen; fi++) {
        const f = forceList[fi]!;
        if (f.disabled) continue;
        const ci = forceCiList[fi]!;
        f.computeConstraint(currentAlpha);
        f.computeDerivatives(ci);
        const Jblock = f.J[ci]!;
        const Hcols = f.HCols[ci]!;
        const fHard = f.hard;
        const fLambda = f.lambda;
        const fPenalty = f.penalty;
        const fC = f.C;
        const fMin = f.fmin;
        const fMax = f.fmax;
        const rows = f.rows;
        for (let r = 0; r < rows; r++) {
          const lambda = fHard[r]! === 1 ? fLambda[r]! : 0;
          const kC = fPenalty[r]! * fC[r]! + lambda;
          const lo = fMin[r]!;
          const hi = fMax[r]!;
          const fc = kC < lo ? lo : kC > hi ? hi : kC;
          const baseJ = r * dim;
          const penalty_r = fPenalty[r]!;
          const absF = fc < 0 ? -fc : fc;
          if (dim === 2) {
            const j0 = Jblock[baseJ]!;
            const j1 = Jblock[baseJ + 1]!;
            rhs[0]! += j0 * fc;
            rhs[1]! += j1 * fc;
            lhs[0]! += penalty_r * j0 * j0;
            lhs[1]! += penalty_r * j0 * j1;
            lhs[2]! += penalty_r * j1 * j0;
            lhs[3]! += penalty_r * j1 * j1;
            if (absF > TINY) {
              lhs[0]! += Hcols[baseJ]! * absF;
              lhs[3]! += Hcols[baseJ + 1]! * absF;
            }
          } else {
            for (let k = 0; k < dim; k++) rhs[k]! += Jblock[baseJ + k]! * fc;
            for (let i = 0; i < dim; i++) {
              const ji = penalty_r * Jblock[baseJ + i]!;
              for (let j = 0; j < dim; j++) {
                lhs[i * dim + j]! += ji * Jblock[baseJ + j]!;
              }
            }
            if (absF > TINY) {
              for (let k = 0; k < dim; k++) {
                lhs[k * dim + k]! += Hcols[baseJ + k]! * absF;
              }
            }
          }
        }
      }

      // Solve `lhs · delta = -rhs`, write `position -= delta`.
      solveSPD(lhs, rhs, dim);
      if (dim === 2) {
        positions[off]! -= rhs[0]!;
        positions[off + 1]! -= rhs[1]!;
      } else {
        for (let k = 0; k < dim; k++) positions[off + k]! -= rhs[k]!;
      }
    }
  }

  /** Dual update over all forces. */
  private _dualPass(currentAlpha: number): void {
    const beta = this.beta;
    const allForces = this._forces;
    for (let fi = 0; fi < allForces.length; fi++) {
      const f = allForces[fi]!;
      if (f.disabled) continue;
      f.computeConstraint(currentAlpha);
      const fHard = f.hard;
      const fLambda = f.lambda;
      const fPenalty = f.penalty;
      const fC = f.C;
      const fMin = f.fmin;
      const fMax = f.fmax;
      const fStiff = f.stiffness;
      const fFracture = f.fracture;
      const rows = f.rows;
      for (let r = 0; r < rows; r++) {
        const lambda = fHard[r]! === 1 ? fLambda[r]! : 0;
        const kC = fPenalty[r]! * fC[r]! + lambda;
        const lo = fMin[r]!;
        const hi = fMax[r]!;
        const newLambda = kC < lo ? lo : kC > hi ? hi : kC;
        fLambda[r]! = newLambda;
        const absLambda = newLambda < 0 ? -newLambda : newLambda;
        if (absLambda >= fFracture[r]!) {
          f.disable();
          break;
        }
        if (newLambda > lo && newLambda < hi) {
          const stiff = fStiff[r]!;
          const cap = stiff < PENALTY_MAX ? stiff : PENALTY_MAX;
          const absC = fC[r]! < 0 ? -fC[r]! : fC[r]!;
          const next = fPenalty[r]! + beta * absC;
          fPenalty[r]! = next > cap ? cap : next;
        }
      }
    }
  }

  // ─── Buffer growth ───────────────────────────────────────────────

  private _growCellArrays(): void {
    const newLen = this.dims.length * 2;
    const newDims = new Uint8Array(newLen);
    const newOffsets = new Uint32Array(newLen);
    const newMasses = new Float64Array(newLen);
    newDims.set(this.dims);
    newOffsets.set(this.offsets);
    newMasses.set(this.masses);
    this.dims = newDims;
    this.offsets = newOffsets;
    this.masses = newMasses;
  }

  /** @internal — set by reactive.ts when it installs a driver. */
  _reactiveHandle?: { dispose(): void; invalidate(): void };
  /** @internal — convenience accessor for legacy paths. */
  get _reactiveDispose(): (() => void) | undefined {
    return this._reactiveHandle?.dispose.bind(this._reactiveHandle);
  }
  set _reactiveDispose(v: (() => void) | undefined) {
    if (v === undefined) this._reactiveHandle = undefined;
  }

  private _growScalarBuffers(needed: number): void {
    let cap = this._capacity || 1;
    while (cap < this._totalDof + needed) cap *= 2;
    const newPositions = new Float64Array(cap);
    const newInitials = new Float64Array(cap);
    const newInertials = new Float64Array(cap);
    newPositions.set(this.positions);
    newInitials.set(this.initials);
    newInertials.set(this.inertials);
    this.positions = newPositions;
    this.initials = newInitials;
    this.inertials = newInertials;
    this._capacity = cap;
  }
}

// ─── Reactive driver lazy-install hook ───────────────────────────────
//
// `Solver.bind()` calls `installReactiveDriver(this)` on first
// invocation. The implementation lives in `reactive.ts`; we use a
// late-bound function ref to avoid a top-level import cycle (and
// to keep the reactive cost off solvers that never bind a signal).
// `reactive.ts` registers itself via `setReactiveInstaller` at
// module load.

let installReactiveDriver: (s: Solver) => void = () => {
  throw new Error(
    "AVBD: Solver.bind() called before reactive integration was loaded. " +
      "Make sure `_proto-avbd/reactive.ts` is reachable in your import graph.",
  );
};

/** @internal — reactive.ts installs its driver factory here. */
export function setReactiveInstaller(installer: (s: Solver) => void): void {
  installReactiveDriver = installer;
}
