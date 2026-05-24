// world.ts — `world(opts)` factory for 2D rigid-body scenes.
//
// Builds a `Constraints` with a physics + contacts pipeline:
//
//   [angularClamp, broadphase, snapshot, prepare, integrate,
//    solveWithVelocity, writeback]
//
// Tracks bodies (via `c.onAdd`/`c.onRemove`), maintains the box-box
// contact manifold lifecycle, registers joint-linked pairs to keep
// the broadphase from generating redundant contact terms between
// jointed bodies. The reactive driver is disposed on construction —
// rigid scenes drive their step explicitly (`world.step(dt)`,
// `animate(world)`, or `fixedStep(world, 1/60)`).
//
// The pipeline is declared in full at construction time. To extend
// (e.g. add a recorder phase), either splice it into `c.pipeline`
// after construction, or write a new factory that declares the
// pipeline you want.

import { Constraints } from "./cluster";
import { ensureCapacity, type Phase, prepare, snapshot, writeback } from "./phases";
import { type PhysicsOpts } from "./physics";
import { Body, BoxContact, Joint } from "./rigid";

export interface WorldOpts extends PhysicsOpts {
  /** Hard cap on angular speed (rad/s) — matches the reference 2D
   *  AVBD demo's `±50` rad/s clamp, applied each sub-step before
   *  the inertial extrapolation. Prevents a body that picked up
   *  spurious angular impulse during drag or contact transition
   *  from spinning out of control. Default `50`. */
  maxAngularSpeed?: number;
}

export interface World extends Constraints {
  /** External acceleration vector. */
  readonly aExt: Float64Array;
  /** Read velocity for cell `id`. */
  velocity(id: number, out?: number[]): number[];
  /** Write velocity for cell `id`. */
  setVelocity(id: number, value: ArrayLike<number>): void;
  /** Per-tick velocity damping. */
  damping: number;
  /** All `Body` instances currently registered. */
  readonly bodies: readonly Body[];
}

/** Build a `Constraints` configured for 2D rigid-body physics:
 *  velocity + gravity + broadphase + contact manifolds.
 *
 *    const w = world({ gravity: [0, 1500], iterations: 24 });
 *    const a = w.add(body({ size: { w: 40, h: 40 } }, { x: 0, y: 0 }));
 *    const b = w.add(body({ size: { w: 40, h: 40 } }, { x: 100, y: 0 }));
 *    w.add(joint(a, b, { x: 0, y: 0 }, { x: 0, y: 0 }));
 *    this.anim.start(fixedStep(w, 1/60));
 */
export function world(opts: WorldOpts = {}): World {
  // Defaults tuned for AVBD physics — postStabilize + gentle damping.
  const c = new Constraints({
    iterations: opts.iterations ?? 10,
    alpha: opts.alpha ?? 0.99,
    beta: opts.beta ?? 1e5,
    gamma: opts.gamma ?? 0.99,
    postStabilize: opts.postStabilize ?? true,
  }) as World;

  // ─── Physics state (closed over by phases) ────────────────────────
  const solver = c.solver;
  let velocities = new Float64Array(solver.positions.length);
  let prevVelocities = new Float64Array(velocities.length);
  const aExt = opts.gravity ? Float64Array.from(opts.gravity) : new Float64Array(0);
  let aExtNormSq = 0;
  for (let i = 0; i < aExt.length; i++) aExtNormSq += aExt[i]! * aExt[i]!;
  let damping = opts.damping ?? 1;
  const adaptive = (opts.adaptiveWarmstart ?? aExtNormSq > 0) && aExtNormSq > 0;
  const maxAngularSpeed = opts.maxAngularSpeed ?? 50;

  // ─── Rigid bookkeeping ────────────────────────────────────────────
  const bodies: Body[] = [];
  const manifolds = new Map<string, BoxContact>();
  const jointed = new Map<string, number>();

  c.onAdd(rel => {
    if (rel instanceof Body) {
      bodies.push(rel);
    } else if (rel instanceof Joint) {
      // Joint must be added AFTER its bodies (so cellIds are set).
      const lo = Math.min(rel.bodyA.cellId, rel.bodyB.cellId);
      const hi = Math.max(rel.bodyA.cellId, rel.bodyB.cellId);
      const key = `${lo}_${hi}`;
      jointed.set(key, (jointed.get(key) ?? 0) + 1);
    }
  });
  c.onRemove(rel => {
    if (rel instanceof Body) {
      const idx = bodies.indexOf(rel);
      if (idx >= 0) bodies.splice(idx, 1);
    } else if (rel instanceof Joint) {
      const lo = Math.min(rel.bodyA.cellId, rel.bodyB.cellId);
      const hi = Math.max(rel.bodyA.cellId, rel.bodyB.cellId);
      const key = `${lo}_${hi}`;
      const n = (jointed.get(key) ?? 0) - 1;
      if (n <= 0) jointed.delete(key);
      else jointed.set(key, n);
    }
  });

  // ─── Phase: angular speed clamp ───────────────────────────────────
  // Runs first each sub-step. AVBD ref clamps ω at ±maxAngularSpeed
  // before the inertial extrapolation, preventing a body that picked
  // up spurious angular impulse from spinning out of control.
  const angularClamp: Phase = (c, dt) => {
    if (dt <= 0) return;
    velocities = ensureCapacity(velocities, c.solver.positions.length);
    const offsets = c.solver.offsets;
    const dims = c.solver.dims;
    for (const body of bodies) {
      if (body.cellId < 0) continue;
      const off = offsets[body.cellId]!;
      if (dims[body.cellId]! >= 3) {
        const w = velocities[off + 2]!;
        if (w > maxAngularSpeed) velocities[off + 2]! = maxAngularSpeed;
        else if (w < -maxAngularSpeed) velocities[off + 2]! = -maxAngularSpeed;
      }
    }
  };

  // ─── Phase: broadphase + manifold lifecycle ───────────────────────
  // O(n²) bounding-radius sweep; creates a `BoxContact` term for
  // each newly-overlapping body pair, disposes manifolds whose
  // pairs no longer overlap. Joint-linked pairs are skipped.
  const broadphase: Phase = (c) => {
    const N = bodies.length;
    const positions = c.solver.positions;
    const offsets = c.solver.offsets;
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) {
      const A = bodies[i]!;
      if (A.cellId < 0) continue;
      const aOff = offsets[A.cellId]!;
      const ax = positions[aOff]!;
      const ay = positions[aOff + 1]!;
      for (let j = i + 1; j < N; j++) {
        const B = bodies[j]!;
        if (B.cellId < 0) continue;
        if (A.mass === 0 && B.mass === 0) continue;
        const lo = Math.min(A.cellId, B.cellId);
        const hi = Math.max(A.cellId, B.cellId);
        if (jointed.has(`${lo}_${hi}`)) continue;
        const bOff = offsets[B.cellId]!;
        const dx = ax - positions[bOff]!;
        const dy = ay - positions[bOff + 1]!;
        const r = A.radius + B.radius;
        if (dx * dx + dy * dy > r * r) continue;
        const key = `${lo}_${hi}`;
        seen.add(key);
        if (!manifolds.has(key)) {
          const m = new BoxContact(c.solver, A, B);
          c.solver.addTerm(m);
          manifolds.set(key, m);
        }
      }
    }
    for (const [key, m] of manifolds) {
      if (!seen.has(key)) {
        m.dispose();
        manifolds.delete(key);
      }
    }
  };

  // ─── Phase: integrate (inertial extrapolation) ────────────────────
  // Same shape as `physics()`'s integrate phase. Lives here as a
  // closure over local `velocities` / `aExt` / `damping` rather
  // than being shared, to keep the factory self-contained.
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
        anchors[off + k] = linTerm + dt2 * a;
        positions[off + k] = linTerm + dt2 * a * accelWeight;
      }
    }
  };

  // ─── Phase: solve + velocity update ──────────────────────────────
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

  c.pipeline = [angularClamp, broadphase, snapshot, prepare, integrate, solveWithVelocity, writeback];

  // Take over the time loop.
  c.dispose();

  // ─── Public surface ──────────────────────────────────────────────
  Object.defineProperty(c, "aExt", { value: aExt, writable: false, enumerable: true });
  Object.defineProperty(c, "bodies", { value: bodies as readonly Body[], enumerable: true });
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
