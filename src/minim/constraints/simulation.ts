// simulation.ts — time-stepping wrapper around `Cluster`.
//
// Wraps a `Cluster`'s solver with velocity, gravity, and a `tick`
// that advances by `dt` seconds. The simulation owns the time
// loop and disposes the cluster's reactive driver on construction;
// signal sync (read all bound signals before tick, write solved
// values back after) goes through `writeBack` so the writeback
// doesn't re-trigger anything that just wrote a signal.

import type { Tick } from "../core/anim";
import type { Pack, Signal } from "../signals";
import type { Cluster } from "./cluster";

export interface SimulationOpts {
  /** External acceleration (e.g. gravity). Length must be ≥ the
   *  largest cell dim in the cluster. Default: zero vector. */
  gravity?: ArrayLike<number>;
}

export class Simulation {
  readonly cluster: Cluster;
  readonly aExt: Float64Array;
  velocities: Float64Array;
  private _velocityCapacity: number;

  constructor(cluster: Cluster, opts: SimulationOpts = {}) {
    this.cluster = cluster;
    const grav = opts.gravity;
    if (grav) {
      this.aExt = new Float64Array(grav.length);
      for (let i = 0; i < grav.length; i++) this.aExt[i]! = grav[i]!;
    } else {
      this.aExt = new Float64Array(0);
    }
    this._velocityCapacity = cluster.solver.positions.length;
    this.velocities = new Float64Array(this._velocityCapacity);
    // Tear down the cluster's reactive driver — Simulation owns the
    // time loop and does its own signal sync.
    cluster.dispose();
  }

  private _ensureVelocityCapacity(): void {
    if (this.cluster.solver.positions.length > this._velocityCapacity) {
      this._velocityCapacity = this.cluster.solver.positions.length;
      const grown = new Float64Array(this._velocityCapacity);
      grown.set(this.velocities);
      this.velocities = grown;
    }
  }

  velocity(id: number, out: number[] = []): number[] {
    this._ensureVelocityCapacity();
    const off = this.cluster.solver.offsets[id]!;
    const dim = this.cluster.solver.dims[id]!;
    for (let k = 0; k < dim; k++) out[k] = this.velocities[off + k]!;
    out.length = dim;
    return out;
  }

  setVelocity(id: number, value: ArrayLike<number>): void {
    this._ensureVelocityCapacity();
    const off = this.cluster.solver.offsets[id]!;
    const dim = this.cluster.solver.dims[id]!;
    for (let k = 0; k < dim; k++) this.velocities[off + k] = value[k] ?? 0;
  }

  /** Advance one frame by `dt` seconds. */
  tick(dt: number): void {
    this._ensureVelocityCapacity();
    const solver = this.cluster.solver;
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
    // Cluster's _bindings is structurally compatible.
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
    const bindings = (this.cluster as any)._bindings as readonly ({ sig: Signal<any>; pack: Pack<any> } | undefined)[];

    // Snapshot signal values into solver positions.
    for (let id = 0; id < N; id++) {
      const b = bindings[id];
      if (!b) continue;
      b.pack.read(b.sig.peek(), positions, offsets[id]!);
    }

    solver.prepare();

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

    for (let id = 0; id < N; id++) {
      if (masses[id]! <= 0) continue;
      const off = offsets[id]!;
      const dim = dims[id]!;
      for (let k = 0; k < dim; k++) {
        velocities[off + k] = (positions[off + k]! - initials[off + k]!) / dt;
      }
    }

    // Write solved positions back into bound signals.
    for (let id = 0; id < N; id++) {
      const b = bindings[id];
      if (!b) continue;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic pack typing
      (b.sig as Signal<any>).value = b.pack.write(positions, offsets[id]!);
    }
  }

  *animate(): Generator<undefined, never, Tick> {
    for (;;) {
      const tick: Tick = yield;
      this.tick(tick.dt);
    }
  }
}
