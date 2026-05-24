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
  /** Multiplicative velocity damping applied each tick — `1` is no
   *  damping (energy-conserving except for whatever the augmented
   *  Lagrangian absorbs through constraint drift), `<1` bleeds
   *  kinetic energy. Default `1`. Cloth and rope-like scenes with
   *  many coupled hard constraints typically want `0.97`–`0.995`
   *  to settle in finite time; rigid pendula are happy with `1`. */
  damping?: number;
  /** Adaptive warm-start (AVBD §3.7): scale the gravity term in
   *  the position warm-start by how much of last frame's
   *  acceleration was actually in the gravity direction.
   *  - `accelWeight ≈ 1`: body in free-fall, full gravity in seed.
   *  - `accelWeight ≈ 0`: body is being supported (constraints
   *    cancel gravity), no gravity in seed → solver doesn't have
   *    to "pull it back up" every frame, killing the residual
   *    jitter that supported bodies otherwise produce.
   *
   *  The full-gravity inertial extrapolation is still used as the
   *  inertia anchor; only the position warm-start is dampened.
   *  Default `true` whenever gravity is non-zero. */
  adaptiveWarmstart?: boolean;
}

export class Simulation {
  readonly cluster: Cluster;
  readonly aExt: Float64Array;
  damping: number;
  adaptiveWarmstart: boolean;
  velocities: Float64Array;
  prevVelocities: Float64Array;
  private _velocityCapacity: number;
  private _aExtNormSq: number;

  constructor(cluster: Cluster, opts: SimulationOpts = {}) {
    this.cluster = cluster;
    const grav = opts.gravity;
    if (grav) {
      this.aExt = new Float64Array(grav.length);
      for (let i = 0; i < grav.length; i++) this.aExt[i]! = grav[i]!;
    } else {
      this.aExt = new Float64Array(0);
    }
    let nsq = 0;
    for (let i = 0; i < this.aExt.length; i++) nsq += this.aExt[i]! * this.aExt[i]!;
    this._aExtNormSq = nsq;
    this.damping = opts.damping ?? 1;
    this.adaptiveWarmstart = opts.adaptiveWarmstart ?? nsq > 0;
    this._velocityCapacity = cluster.solver.positions.length;
    this.velocities = new Float64Array(this._velocityCapacity);
    this.prevVelocities = new Float64Array(this._velocityCapacity);
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
      const grownPrev = new Float64Array(this._velocityCapacity);
      grownPrev.set(this.prevVelocities);
      this.prevVelocities = grownPrev;
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

  /** Advance one frame by `dt` seconds. No-op for non-positive or
   *  non-finite `dt` — the velocity update divides by `dt`, so a
   *  zero or NaN tick would otherwise inject infinities into every
   *  velocity slot and poison the simulation forever. (`attachRaf`
   *  passes `dt = 0` on its first frame, for instance.) */
  tick(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this._ensureVelocityCapacity();
    const solver = this.cluster.solver;
    const dt2 = dt * dt;
    const aExt = this.aExt;
    const aExtLen = aExt.length;
    const aExtNormSq = this._aExtNormSq;
    const adaptive = this.adaptiveWarmstart && aExtNormSq > 0;
    const positions = solver.positions;
    const initials = solver.initials;
    const inertials = solver.inertials;
    const masses = solver.masses;
    const dims = solver.dims;
    const offsets = solver.offsets;
    const velocities = this.velocities;
    const prevVelocities = this.prevVelocities;
    const N = solver.cellCount;
    // Cluster's _bindings is structurally compatible.
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
    const bindings = (this.cluster as any)._bindings as readonly (
      | { sig: Signal<any>; pack: Pack<any> }
      | undefined
    )[];

    // Snapshot signal values into solver positions.
    for (let id = 0; id < N; id++) {
      const b = bindings[id];
      if (!b) continue;
      b.pack.read(b.sig.peek(), positions, offsets[id]!);
    }

    solver.prepare();

    for (let id = 0; id < N; id++) {
      const off = offsets[id]!;
      if (masses[off]! <= 0) continue;
      const dim = dims[id]!;

      // Adaptive warm-start: project last frame's acceleration onto
      // the gravity direction, normalize by |g|², clamp to [0, 1].
      // The result `accelWeight` modulates the gravity term in the
      // position warm-start (but the inertial anchor still gets full g).
      let accelWeight = 1;
      if (adaptive) {
        let dot = 0;
        for (let k = 0; k < dim && k < aExtLen; k++) {
          const accelK = (velocities[off + k]! - prevVelocities[off + k]!) / dt;
          dot += accelK * aExt[k]!;
        }
        const w = dot / aExtNormSq;
        accelWeight = w < 0 ? 0 : w > 1 ? 1 : w;
        if (!Number.isFinite(accelWeight)) accelWeight = 0;
      }

      for (let k = 0; k < dim; k++) {
        const a = k < aExtLen ? aExt[k]! : 0;
        const linTerm = initials[off + k]! + dt * velocities[off + k]!;
        // Inertial anchor: full gravity (unchanged AVBD inertia term).
        inertials[off + k] = linTerm + dt2 * a;
        // Position warm-start: adaptive gravity (smaller for supported bodies).
        positions[off + k] = linTerm + dt2 * a * accelWeight;
      }
    }

    // Compute velocity from the position at the end of the *regular*
    // iterations (before post-stabilization). The AVBD reference does
    // this in the inner loop at `it == iterations - 1`; we match by
    // hooking `solver.solve`'s `beforePostStab` callback. Counting
    // post-stab into velocity bakes the "free" projection back into
    // momentum and visibly amplifies stack jitter under perturbation.
    const damp = this.damping;
    solver.solve(dt, () => {
      for (let id = 0; id < N; id++) {
        const off = offsets[id]!;
        if (masses[off]! <= 0) continue;
        const dim = dims[id]!;
        for (let k = 0; k < dim; k++) {
          prevVelocities[off + k] = velocities[off + k]!;
          velocities[off + k] = ((positions[off + k]! - initials[off + k]!) / dt) * damp;
        }
      }
    });

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
