// md-linkage.ts — Peaucellier–Lipkin straight-line linkage (1864).
//
// Six bars + one input crank converting circular motion to *exact*
// straight-line motion at the output. The first mechanism ever built
// to do so. Earlier "approximate" mechanisms (Watt's, Roberts')
// traced near-straight curves that diverged at the extremes.
//
// Geometry: O fixed, C fixed at distance r from O. The crank rotates
// joint A around C with arm length r — so A traces a circle that
// passes through O. Bars |OB| = |OD| = R; rhombus |AB| = |BE| = |DE|
// = |AD| = b. Then |OA|·|OE| = R²−b² (the inversion identity), and
// since A lies on a circle through the centre of inversion (O), its
// image E lies on a straight line perpendicular to OC.
//
// Lens story: theta is the only DOF. Drag the blue input — polar's
// "circular" policy writes back through theta. Drag the red output —
// argminVec inverts through theta in one Newton step (1 input → 2
// outputs; the rank-1 Jacobian is fine because Levenberg-Marquardt
// damping keeps the solve well-conditioned). Either way, the entire
// six-bar mechanism reconfigures so every length constraint is
// preserved.

import {
  Anchor,
  argminVec,
  circle,
  computed,
  curve,
  type CurveSegment,
  Diagram,
  drive,
  handle,
  label,
  line,
  Mount,
  num,
  type Num,
  type Of,
  polar,
  Vec,
  vec,
  type Writable,
} from "../../minim";

type V = Of<Vec>;

const TAU = Math.PI * 2;

/** Intersection of two circles. `branch ∈ {+1, −1}` picks which side
 *  of the chord. Returns `c1` (degenerate) when no real intersection. */
function circleIntersect(c1: V, r1: number, c2: V, r2: number, branch: 1 | -1): V {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || d > r1 + r2 || d < Math.abs(r1 - r2)) return c1;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const px = c1.x + (a * dx) / d;
  const py = c1.y + (a * dy) / d;
  return {
    x: px + (branch * h * dy) / d,
    y: py - (branch * h * dx) / d,
  };
}

export class MdLinkage extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 360);

    // Bar lengths chosen so the mechanism stays well within the view.
    // R > b is required (otherwise √(R²−b²) is imaginary); the
    // inversion identity gives the trace's distance from O as
    // (R²−b²)/(2r) along OC, which lands the line just left of centre.
    const R = 80;
    const b = 70;
    const r = 60;

    const cy = view.center.value.y;
    const O = vec(view.center.value.x - 80, cy);
    const C = vec(O.value.x + r, cy);

    // Single mechanism DOF — everything else is derived. Auto-oscillates
    // when no handle is being dragged.
    const theta = num(0.6);

    // Crank tip: writable through `polar`'s circular policy. Drag
    // routes back through theta only (centre and radius stay locked).
    const A = polar(C, r, theta, "circular");

    // Rhombus corners B (upper) and D (lower). Each is the
    // circle-circle intersection of {O, R} and {A, b}; branch sign
    // selects upper vs lower.
    const B = computed(() => circleIntersect(O.value, R, A.value, b, +1), Vec);
    const D = computed(() => circleIntersect(O.value, R, A.value, b, -1), Vec);

    // The output joint E — opposite corner of the rhombus from A.
    // Among the two {B, b} ∩ {D, b} solutions, A is one (the rhombus's
    // near corner) and E is the other (the far corner).
    const computeE = (Av: V): V => {
      const Ov = O.value;
      const Bv = circleIntersect(Ov, R, Av, b, +1);
      const Dv = circleIntersect(Ov, R, Av, b, -1);
      const c1 = circleIntersect(Bv, b, Dv, b, +1);
      const c2 = circleIntersect(Bv, b, Dv, b, -1);
      const d1 = (c1.x - Av.x) ** 2 + (c1.y - Av.y) ** 2;
      const d2 = (c2.x - Av.x) ** 2 + (c2.y - Av.y) ** 2;
      return d1 > d2 ? c1 : c2;
    };

    // E as a writable Vec lensed back through theta. argminVec runs
    // one Newton step per write — the rank-1 Jacobian (1 input → 2
    // outputs) projects the dragged target onto E's reachable line.
    const E = argminVec(
      [theta as unknown as Writable<Num>],
      ([t]) => {
        const Av = {
          x: C.value.x + r * Math.cos(t),
          y: C.value.y + r * Math.sin(t),
        };
        return computeE(Av);
      },
      [1],
    );

    // ── Visualisation ──────────────────────────────────────────────

    // Crank circle.
    s(circle(C, r, { thin: true, dashed: true, opacity: 0.25 }));

    // Pre-computed trace of E over the reachable θ range. The mechanism
    // is singular at θ = π (A coincides with O), so we stay clear of it.
    const traceSegs: CurveSegment[] = [];
    const N = 80;
    const tMin = -2.5;
    const tMax = 2.5;
    let prev: V | null = null;
    for (let i = 0; i <= N; i++) {
      const t = tMin + (i / N) * (tMax - tMin);
      const Av = {
        x: C.value.x + r * Math.cos(t),
        y: C.value.y + r * Math.sin(t),
      };
      const Ev = computeE(Av);
      if (prev) traceSegs.push({ kind: "line", from: prev, to: Ev });
      prev = Ev;
    }
    s(curve(traceSegs, { thin: true, opacity: 0.65, stroke: "#e25c5c" }));

    // Bars.
    s(line(O, B, { thin: true }));
    s(line(O, D, { thin: true }));
    s(line(A, B, { thin: true }));
    s(line(A, D, { thin: true }));
    s(line(B, E, { thin: true }));
    s(line(D, E, { thin: true }));

    // Fixed pivots.
    s(circle(O, 4, { fill: true }));
    s(circle(C, 4, { fill: true }));

    // Free rhombus corners (decorative — drag goes through A or E).
    s(circle(B, 4, { fill: "var(--bg-color, white)", thin: true }));
    s(circle(D, 4, { fill: "var(--bg-color, white)", thin: true }));

    const aH = s(handle(A, { fill: "#5b8def", r: 7 }));
    const eH = s(handle(E, { fill: "#e25c5c", r: 7 }));

    // Bouncing auto-rotation while idle. Reverses at the soft limits
    // (clamped to the reachable θ range so a manual drag past the
    // limit doesn't leave the auto driver chasing a singular config).
    const omega = TAU * 0.18;
    let dir = 1;
    this.anim.start(
      drive(tick => {
        if (aH.dragging.value || eH.dragging.value) return;
        const next = theta.peek() + dir * omega * tick.dt;
        if (next > 2.4 || next < -2.4) dir = -dir;
        theta.value = Math.max(-2.4, Math.min(2.4, next));
      }),
    );

    s(
      label(view.top.down(20), "drag the blue crank or the red output", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "Peaucellier–Lipkin (1864) · 6 bars convert circular to exact straight-line motion · the red trail is geometrically straight",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
