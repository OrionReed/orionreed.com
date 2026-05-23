// simulation.ts — time-stepping wrapper around `Solver`.
//
// Physics is composition, not a mode. The `Solver` itself is time-
// free: given an inertial anchor `y` and constraints, find `x`. A
// `Simulation` adds three things:
//
//   1. Per-cell velocity, packed alongside the solver's SOA buffers.
//   2. Inertial extrapolation each tick: `y = x⁻ + dt·v + dt²·a`.
//   3. Velocity update at the end: `v = (x − x⁻) / dt`.
//
// Cells with `mass = 0` are kinematic — Simulation skips their
// inertial extrapolation and velocity update.
//
// Composition with the Anim runtime: `Simulation.animate()` yields
// each frame and resumes with the engine's `Tick`. Compose with
// `race`, `suspend`, etc., from `core/anim`.

import type { Tick } from "../core/anim";
import type { Pack, Signal } from "../signals";
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
  /** Per-cell velocity, packed in the same SOA layout as
   *  `solver.positions`. Grows when the solver grows. */
  velocities: Float64Array;
  private _velocityCapacity: number;

  constructor(solver: Solver, opts: SimulationOpts = {}) {
    this.solver = solver;
    const grav = opts.gravity;
    if (grav) {
      this.aExt = new Float64Array(grav.length);
      for (let i = 0; i < grav.length; i++) this.aExt[i]! = grav[i]!;
    } else {
      this.aExt = new Float64Array(0);
    }
    this._velocityCapacity = solver.positions.length;
    this.velocities = new Float64Array(this._velocityCapacity);
    // Simulation owns the time loop — disable the reactive driver
    // so signal writes don't kick off conflicting solver.step calls.
    // Signal sync happens inside `tick()` instead.
    if (solver._reactiveHandle !== undefined) {
      solver._reactiveHandle.dispose();
      solver._reactiveHandle = undefined;
    }
  }

  private _ensureVelocityCapacity(): void {
    if (this.solver.positions.length > this._velocityCapacity) {
      this._velocityCapacity = this.solver.positions.length;
      const grown = new Float64Array(this._velocityCapacity);
      grown.set(this.velocities);
      this.velocities = grown;
    }
  }

  /** Read the velocity of cell `id` into `out` (or a fresh array). */
  velocity(id: number, out: number[] = []): number[] {
    this._ensureVelocityCapacity();
    const off = this.solver.offsets[id]!;
    const dim = this.solver.dims[id]!;
    for (let k = 0; k < dim; k++) out[k] = this.velocities[off + k]!;
    out.length = dim;
    return out;
  }

  /** Set the velocity of cell `id`. */
  setVelocity(id: number, value: ArrayLike<number>): void {
    this._ensureVelocityCapacity();
    const off = this.solver.offsets[id]!;
    const dim = this.solver.dims[id]!;
    for (let k = 0; k < dim; k++) this.velocities[off + k] = value[k] ?? 0;
  }

  /** Advance one frame by `dt` seconds.
   *
   *  1. `solver.prepare()` snapshots positions and resets `inertials`
   *     to the current positions.
   *  2. Overwrite `inertials` with `x⁻ + dt·v + dt²·a` for cells
   *     with mass > 0, and seed `positions` at that extrapolation.
   *  3. `solver.solve(dt)` iterates.
   *  4. Velocity update: `v = (x − x⁻) / dt`. */
  tick(dt: number): void {
    this._ensureVelocityCapacity();
    const solver = this.solver;
    const dt2 = dt * dt;
    const aExt = this.aExt;
    const aExtLen = aExt.length;
    const positions = solver.positions;
    const initials = solver.initials;
    const inertials = solver.inertials;
    const masses = solver.masses;
    const dims = solver.dims;
    const offsets = solver.offsets;
    const velocities = this.velocities;
    const N = solver.cellCount;
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
    const bindings = solver._cellToBinding as readonly { sig: Signal<any>; pack: Pack<any> }[];

    // Snapshot signal values into solver positions (catches user
    // writes since the last tick).
    for (let id = 0; id < N; id++) {
      const b = bindings[id];
      if (!b) continue;
      b.pack.read(b.sig.peek(), positions, offsets[id]!);
    }

    solver.prepare();

    // Inertial extrapolation + initial guess seeded at extrapolated point.
    for (let id = 0; id < N; id++) {
      if (masses[id]! <= 0) continue;
      const off = offsets[id]!;
      const dim = dims[id]!;
      for (let k = 0; k < dim; k++) {
        const a = k < aExtLen ? aExt[k]! : 0;
        const y = initials[off + k]! + dt * velocities[off + k]! + dt2 * a;
        inertials[off + k] = y;
        positions[off + k] = y;
      }
    }

    solver.solve(dt);

    // Velocity update.
    for (let id = 0; id < N; id++) {
      if (masses[id]! <= 0) continue;
      const off = offsets[id]!;
      const dim = dims[id]!;
      for (let k = 0; k < dim; k++) {
        velocities[off + k] = (positions[off + k]! - initials[off + k]!) / dt;
      }
    }

    // Write solved positions back into bound signals. We use peek/
    // set value directly — there's no preEffect to mute, and any
    // subscribers (UI effects) will see the updated values on the
    // next flush.
    for (let id = 0; id < N; id++) {
      const b = bindings[id];
      if (!b) continue;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
      (b.sig as Signal<any>).value = b.pack.write(positions, offsets[id]!);
    }
  }

  /** Animator-shaped generator. Each yield parks one frame; the
   *  Anim runtime resumes with a `Tick` carrying `dt`. */
  *animate(): Generator<undefined, never, Tick> {
    for (;;) {
      const tick: Tick = yield;
      this.tick(tick.dt);
    }
  }
}
