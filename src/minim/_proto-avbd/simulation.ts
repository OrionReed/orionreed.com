// simulation.ts — time-stepping wrapper around `Solver`.
//
// Physics is composition, not a mode. The `Solver` itself is time-
// free: given an inertial anchor `y` and constraints, find `x`. A
// `Simulation` adds three things:
//
//   1. Per-cell velocity, allocated lazily on demand.
//   2. Inertial extrapolation each tick: `y = x⁻ + dt·v + dt²·a`.
//   3. Velocity update at the end: `v = (x − x⁻) / dt`.
//
// Velocity lives off the `Cell` (in a `WeakMap`) so static editing
// doesn't pay the memory cost. Cells with `mass = 0` are kinematic
// — Simulation skips their inertial extrapolation and velocity
// update.
//
// Composition with the Anim runtime: `Simulation.animate()` is an
// `Animator<never, Tick>`. It parks each frame, resumes with the
// engine's `Tick`, and runs one `tick()` per frame. Pause it via
// `suspend`; slo-mo via `tick(dt * 0.1)`; multi-rate physics via
// two simulations with independent driving generators.

import type { Tick } from "../core/anim";
import type { Cell } from "./cell";
import type { Solver } from "./solver";

export interface SimulationOpts {
  /** External acceleration (e.g. gravity). Length must be ≥ the
   *  largest cell dim in the solver. Default: zero vector. */
  gravity?: ArrayLike<number>;
}

export class Simulation {
  readonly solver: Solver;
  /** External acceleration applied to every cell each tick. */
  readonly aExt: Float64Array;
  /** Per-cell velocity. Lazily allocated. WeakMap so disposed cells
   *  are GC-collectable without manual cleanup. */
  private readonly _velocity = new WeakMap<Cell, Float64Array>();

  constructor(solver: Solver, opts: SimulationOpts = {}) {
    this.solver = solver;
    const grav = opts.gravity;
    if (grav) {
      this.aExt = new Float64Array(grav.length);
      for (let i = 0; i < grav.length; i++) this.aExt[i]! = grav[i]!;
    } else {
      this.aExt = new Float64Array(0);
    }
  }

  /** Get (or lazily allocate) the velocity buffer for `cell`. Mutating
   *  the returned array sets the cell's velocity. */
  velocity(cell: Cell): Float64Array {
    let v = this._velocity.get(cell);
    if (!v) {
      v = new Float64Array(cell.dim);
      this._velocity.set(cell, v);
    }
    return v;
  }

  /** Advance one frame by `dt` seconds.
   *
   *  1. `solver.prepare()` snapshots positions and resets inertial
   *     anchors to the current position.
   *  2. We overwrite `cell.inertial` with the inertial extrapolation
   *     `x⁻ + dt·v + dt²·a` for cells with mass > 0, and seed
   *     `position` at that extrapolation as the initial guess.
   *  3. `solver.solve(dt)` iterates.
   *  4. Velocity update: `v = (x − x⁻) / dt`.
   */
  tick(dt: number): void {
    const solver = this.solver;
    const cells = solver.cells;
    const dt2 = dt * dt;
    const aExt = this.aExt;
    const aExtLen = aExt.length;

    solver.prepare();

    // Inertial extrapolation: y = x⁻ + dt·v + dt²·a; seed x = y.
    for (const cell of cells) {
      if (cell.mass <= 0) continue;
      const v = this.velocity(cell);
      const dim = cell.dim;
      for (let k = 0; k < dim; k++) {
        const a = k < aExtLen ? aExt[k]! : 0;
        const y = cell.initial[k]! + dt * v[k]! + dt2 * a;
        cell.inertial[k]! = y;
        cell.position[k]! = y;
      }
    }

    solver.solve(dt);

    // Velocity update: v = (x − x⁻) / dt.
    for (const cell of cells) {
      if (cell.mass <= 0) continue;
      const v = this.velocity(cell);
      const dim = cell.dim;
      for (let k = 0; k < dim; k++) {
        v[k]! = (cell.position[k]! - cell.initial[k]!) / dt;
      }
    }
  }

  /** Animator-shaped generator. Each yield parks one frame; the
   *  Anim runtime resumes with a `Tick` carrying `dt`. Compose with
   *  `race`, `suspend`, etc., from the core anim runtime. */
  *animate(): Generator<undefined, never, Tick> {
    for (;;) {
      const tick: Tick = yield;
      this.tick(tick.dt);
    }
  }
}
