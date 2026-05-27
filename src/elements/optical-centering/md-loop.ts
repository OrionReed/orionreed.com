// md-loop.ts — vector-loop Newton solver for a 4-bar linkage.
//
// Each bar is parameterised by its angle. The mechanism is the
// *loop-closure equation* — the sum of bar vectors around the closed
// loop must equal zero. Given the input crank angle, two scalar
// equations (x, y) in two unknown angles (θ_AB, θ_BP) are solved
// each frame by Newton-Raphson seeded with last frame's solution,
// so the output angles evolve continuously through the cycle without
// branch decisions.
//
// Contrast with md-linkage (forward dyad cascade): there the unknowns
// were *positions* found by closed-form circle-circle intersection
// with discrete branch picks, vulnerable to flips at tangent
// configurations. Here the unknowns are *angles*, evolved smoothly
// from one frame to the next; even mechanisms whose position-form
// cascades go singular are well-posed in angle-space because angle
// continuity is invariant.

import {
  Anchor,
  argminVec,
  type CurveSegment,
  circle,
  derive,
  curve,
  Diagram,
  drive,
  handle,
  label,
  line,
  Mount,
  type Num,
  num,
  type Inner,
  polar,
  Vec,
  type Writable,
} from "../../minim";

type V = Inner<Vec>;

const TAU = Math.PI * 2;

interface FourBarSolution {
  thetaAB: number;
  thetaBP: number;
  A: V;
  B: V;
}

/** Solve a 4-bar linkage (one closed loop) by Newton-Raphson on
 *  (θ_AB, θ_BP). The seed angles must match the previous frame's
 *  solution to keep the angles continuous through tangent
 *  configurations. */
function solveFourBar(
  O: V,
  P: V,
  r1: number,
  r2: number,
  r3: number,
  thetaOA: number,
  seedAB: number,
  seedBP: number,
): FourBarSolution {
  const Ax = O.x + r1 * Math.cos(thetaOA);
  const Ay = O.y + r1 * Math.sin(thetaOA);
  let tAB = seedAB;
  let tBP = seedBP;
  for (let iter = 0; iter < 12; iter++) {
    const fx = Ax + r2 * Math.cos(tAB) - P.x - r3 * Math.cos(tBP);
    const fy = Ay + r2 * Math.sin(tAB) - P.y - r3 * Math.sin(tBP);
    if (fx * fx + fy * fy < 1e-14) break;
    const Jxx = -r2 * Math.sin(tAB);
    const Jxy = r3 * Math.sin(tBP);
    const Jyx = r2 * Math.cos(tAB);
    const Jyy = -r3 * Math.cos(tBP);
    const det = Jxx * Jyy - Jxy * Jyx;
    if (Math.abs(det) < 1e-9) break;
    tAB += (Jxy * fy - Jyy * fx) / det;
    tBP += (Jyx * fx - Jxx * fy) / det;
  }
  return {
    thetaAB: tAB,
    thetaBP: tBP,
    A: { x: Ax, y: Ay },
    B: { x: Ax + r2 * Math.cos(tAB), y: Ay + r2 * Math.sin(tAB) },
  };
}

// Crank-rocker proportions (Grashof: 50 + 100 ≤ 90 + 80, so the crank
// rotates fully and the rocker oscillates).
const r1 = 50;
const r2 = 90;
const r3 = 80;
const frame = 100;

export class MdLoop extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);

    const O = view.center.left(frame / 2).down(20);
    const P = O.right(frame);

    const thetaOA = num(0.6).cyclic(TAU);
    // O is a fixed pivot — snapshot for polar's writable-center contract.
    const A = polar(O.value, r1, thetaOA, "circular");

    // Live solver instance — its closure-captured seeds get refreshed
    // to last frame's solution each time `sol` evaluates. The live
    // seeds are also used (read-only) by the inverse forward below.
    let liveAB = 0.5;
    let liveBP = Math.PI - 0.5;
    const sol = derive(() => {
      const r = solveFourBar(O.value, P.value, r1, r2, r3, thetaOA.value, liveAB, liveBP);
      liveAB = r.thetaAB;
      liveBP = r.thetaBP;
      return r;
    });

    const B = Vec.derive(() => sol.value.B);
    const thetaAB = derive(() => sol.value.thetaAB);
    const thetaBP = derive(() => sol.value.thetaBP);

    // Pre-compute the coupler curve with its own private seeds so the
    // sweep doesn't perturb the live solver's continuity state. The
    // result is reused as both the visible trace and the workspace
    // clamp for the inverse.
    const N = 240;
    let gAB = 0.5;
    let gBP = Math.PI - 0.5;
    const gait: V[] = [];
    for (let n = 0; n <= N; n++) {
      const t = (n / N) * TAU;
      const r = solveFourBar(O.value, P.value, r1, r2, r3, t, gAB, gBP);
      gAB = r.thetaAB;
      gBP = r.thetaBP;
      gait.push({ x: (r.A.x + r.B.x) / 2, y: (r.A.y + r.B.y) / 2 });
    }
    const projectOntoGait = (target: V): V => {
      let best = gait[0];
      let bestD2 = Infinity;
      for (const p of gait) {
        const d2 = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = p;
        }
      }
      return best;
    };

    // M (coupler midpoint) as a writable Vec lensed back through θ_OA.
    // The forward reads live seeds without mutating them — `sol` owns
    // that mutation; here we only need the seeds to make Newton's
    // finite-difference Jacobian well-conditioned.
    const M = argminVec(
      [thetaOA as Writable<Num>],
      ([t]) => {
        const r = solveFourBar(O.value, P.value, r1, r2, r3, t, liveAB, liveBP);
        return { x: (r.A.x + r.B.x) / 2, y: (r.A.y + r.B.y) / 2 };
      },
      [1],
      { clampTarget: projectOntoGait },
    );

    const traceSegs: CurveSegment[] = [];
    for (let n = 1; n <= N; n++) {
      traceSegs.push({ kind: "line", from: gait[n - 1], to: gait[n] });
    }
    s(curve(traceSegs, { thin: true, opacity: 0.5, stroke: "#e25c5c" }));

    s(circle(O, r1, { thin: true, dashed: true, opacity: 0.25 }));

    // Angle arc at O — visualises θ_OA growing from horizontal as the
    // crank rotates. Modular wrap so the sweep stays within (0, 2π].
    s(
      curve(
        () => {
          const t = ((thetaOA.value % TAU) + TAU) % TAU;
          return [
            {
              kind: "ellipseArc" as const,
              center: O.value,
              a: 18,
              b: 18,
              rotation: 0,
              a0: 0,
              a1: t,
            },
          ];
        },
        { thin: true, stroke: "#5b8def", opacity: 0.55 },
      ),
    );

    s(
      line(O, A, { thin: true, opacity: 0.5 }),
      line(A, B, { thin: true }),
      line(B, P, { thin: true }),
    );

    s(circle(O, 4, { fill: true }), circle(P, 4, { fill: true }));
    s(circle(B, 3, { fill: "var(--bg-color, white)", thin: true }));

    const aH = s(handle(A, { fill: "#5b8def", r: 7 }));
    const mH = s(handle(M, { fill: "#e25c5c", r: 7 }));

    const omega = TAU * 0.18;
    this.anim.start(
      drive(tick => {
        if (aH.dragging.value || mH.dragging.value) return;
        thetaOA.value = thetaOA.peek() + omega * tick.dt;
      }),
    );

    // Live angle readouts so the angle-space story is visible. Wrap
    // to (-π, π] just for legibility.
    const wrap = (x: number) => x - TAU * Math.round(x / TAU);
    const fmt = (sig: { value: number }) => `${((wrap(sig.value) * 180) / Math.PI).toFixed(0)}°`;
    const corner = view.at(0, 1).right(18);
    const labelAt = (yOffset: number, text: () => string) =>
      label(corner.up(yOffset), derive(text), { align: Anchor.Left });
    s(
      labelAt(64, () => `θ_OA (input)   = ${fmt(thetaOA)}`),
      labelAt(46, () => `θ_AB (coupler) = ${fmt(thetaAB)}`),
      labelAt(28, () => `θ_BP (rocker)  = ${fmt(thetaBP)}`),
    );

    s(
      label(
        view.top.down(20),
        "drag the blue crank or the red tracer — angles propagate via Newton-Raphson on loop closure",
      ),
      label(
        view.bottom.up(10),
        "4-bar · 1 loop · 2 unknown angles solved each frame · seed = last frame's solution",
        { size: 10 },
      ),
    );
  }
}
