// physics.ts — `physics(opts)` factory.
//
// A `Constraints` with a velocity + gravity pipeline and the reactive
// driver disposed. For cloth / chain / particle scenes that need time
// integration but not rigid-body contacts (use `world(opts)` for those).

import { Constraints } from "./cluster";
import type { Phase } from "./phases";
import { ensureCapacity, prepare, snapshot, writeback } from "./phases";
import type { SolverOpts } from "./solver";

export interface PhysicsOpts extends SolverOpts {
  /** External acceleration (e.g. gravity); length ≥ largest cell dim.
   *  Default zero. */
  gravity?: ArrayLike<number>;
  /** Multiplicative per-tick velocity damping. `1` conserves energy,
   *  `<1` bleeds it (cloth/rope want `0.97`–`0.995`). Default `1`. */
  damping?: number;
  /** Adaptive warm-start (AVBD §3.7): scale the warm-start gravity
   *  term by how much of last tick's acceleration was in the gravity
   *  direction — kills jitter under supported bodies. Default `true`
   *  when gravity is non-zero. */
  adaptiveWarmstart?: boolean;
}

export interface Physics extends Constraints {
  /** External acceleration vector (read-write Float64Array). */
  readonly aExt: Float64Array;
  /** Read velocity for cell `id` into `out` (or a fresh array). */
  velocity(id: number, out?: number[]): number[];
  /** Write velocity for cell `id`. */
  setVelocity(id: number, value: ArrayLike<number>): void;
  /** Per-tick velocity damping. Mutable post-construction. */
  damping: number;
}

/** Build a physics `Constraints` (`[snapshot, prepare, integrate,
 *  solveWithVelocity, writeback]`). The reactive driver is disposed —
 *  drive explicitly via `c.step(dt)` / `animate(c)` / `fixedStep(c)`.
 *
 *    const c = physics({ gravity: [0, 90], damping: 0.997 });
 *    c.add(...springs, pin(grid[0][0]));
 *    this.anim.start(animate(c));
 */
export function physics(opts: PhysicsOpts = {}): Physics {
  const c = new Constraints(opts) as Physics;

  // ─── Subsystem state (closed over by phases) ──────────────────────
  const solver = c.solver;
  let velocities = new Float64Array(solver.positions.length);
  let prevVelocities = new Float64Array(velocities.length);
  const aExt = opts.gravity ? Float64Array.from(opts.gravity) : new Float64Array(0);
  let aExtNormSq = 0;
  for (let i = 0; i < aExt.length; i++) aExtNormSq += aExt[i]! * aExt[i]!;
  let damping = opts.damping ?? 1;
  const adaptive = (opts.adaptiveWarmstart ?? aExtNormSq > 0) && aExtNormSq > 0;

  // ─── Phase: integrate ────────────────────────────────────────────
  // Between `prepare()` and `solve(dt)`: overwrite anchors with the
  // inertial extrapolation y = x + dt·v + dt²·g. Adaptive warm-start
  // gates gravity in the position seed but not in the inertia anchor.
  const integrate: Phase = (c, dt) => {
    if (dt <= 0) return;
    velocities = ensureCapacity(velocities, c.solver.positions.length);
    prevVelocities = ensureCapacity(prevVelocities, c.solver.positions.length);
    const dt2 = dt * dt;
    const aExtLen = aExt.length;
    const positions = c.solver.positions;
    const initials = c.solver.initials;
    const anchors = c.solver.anchors;
    const masses = c.solver.masses;
    const dims = c.solver.dims;
    const offsets = c.solver.offsets;
    const N = c.solver.cellCount;
    for (let id = 0; id < N; id++) {
      const off = offsets[id]!;
      if (masses[off]! <= 0) continue;
      const dim = dims[id]!;
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
        anchors[off + k] = linTerm + dt2 * a;
        // Position warm-start: adaptive gravity (smaller for supported bodies).
        positions[off + k] = linTerm + dt2 * a * accelWeight;
      }
    }
  };

  // ─── Phase: solve + velocity update ──────────────────────────────
  // Read velocity in the `beforePostStab` hook (`(positions −
  // initials) / dt`), before the post-stab projection — folding that
  // projection into velocity would re-introduce the drift it removed.
  const solveWithVelocity: Phase = (c, dt) => {
    c.solver.solve(dt, () => {
      if (dt <= 0) return;
      const positions = c.solver.positions;
      const initials = c.solver.initials;
      const masses = c.solver.masses;
      const dims = c.solver.dims;
      const offsets = c.solver.offsets;
      const N = c.solver.cellCount;
      for (let id = 0; id < N; id++) {
        const off = offsets[id]!;
        if (masses[off]! <= 0) continue;
        const dim = dims[id]!;
        for (let k = 0; k < dim; k++) {
          prevVelocities[off + k] = velocities[off + k]!;
          velocities[off + k] = ((positions[off + k]! - initials[off + k]!) / dt) * damping;
        }
      }
    });
  };

  c.pipeline = [snapshot, prepare, integrate, solveWithVelocity, writeback];

  // Take over the time loop — reactive solving would conflict with
  // per-tick velocity integration.
  c.dispose();

  // ─── Public surface (attached to the Constraints) ────────────────
  Object.defineProperty(c, "aExt", { value: aExt, writable: false, enumerable: true });
  Object.defineProperty(c, "damping", {
    get: () => damping,
    set: (v: number) => {
      damping = v;
    },
    enumerable: true,
  });
  c.velocity = (id: number, out: number[] = []): number[] => {
    velocities = ensureCapacity(velocities, c.solver.positions.length);
    const off = c.solver.offsets[id]!;
    const dim = c.solver.dims[id]!;
    for (let k = 0; k < dim; k++) out[k] = velocities[off + k]!;
    out.length = dim;
    return out;
  };
  c.setVelocity = (id: number, value: ArrayLike<number>): void => {
    velocities = ensureCapacity(velocities, c.solver.positions.length);
    prevVelocities = ensureCapacity(prevVelocities, c.solver.positions.length);
    const off = c.solver.offsets[id]!;
    const dim = c.solver.dims[id]!;
    for (let k = 0; k < dim; k++) velocities[off + k] = value[k] ?? 0;
  };

  return c;
}
