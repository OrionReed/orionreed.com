import {
  type CurveSegment,
  curve,
  Diagram,
  derive,
  ellipse,
  handle,
  label,
  line,
  type Mount,
  Vec,
  vec,
} from "../../minim";

type V = { x: number; y: number };

// Two fixed parameters of the confocal grid: which lines to draw.
// Multipliers are unitless (vs the half-focal-distance c), so the
// family rescales as the foci move — same eccentricities, new sizes.
const ELLIPSE_MULTS = [1.08, 1.22, 1.45, 1.8, 2.4]; // a = c × m, m > 1
const HYP_MULTS = [0.18, 0.4, 0.62, 0.85]; // a = c × m, m < 1
// Hyperbola branches are sampled as polylines (no native SVG conic).
// 32 samples × parametric half-width 1.6 covers a comfortable visible
// band; outside the view the polyline just clips.
const HYP_N = 32;
const HYP_T = 1.6;

/** Confocal ellipses and hyperbolas share two foci. The orthogonal
 *  family is built from one scalar parameter each (a > c and a < c
 *  respectively); the probe's position pins the unique pair of curves
 *  through it.
 *
 *  Everything reactive in the foci — drag a focus, the entire grid
 *  re-renders. Drag the probe, the highlighted pair tracks it. */
export class MdConfocal extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 380);

    const cx = view.center.value.x;
    const cy = view.center.value.y;
    const f1 = vec(cx - 80, cy + 10);
    const f2 = vec(cx + 80, cy + 10);
    const probe = vec(cx + 110, cy - 70);

    // Frame: centre, half-focal-distance c, rotation θ (so the
    // canonical ellipse equation lives in the rotated frame).
    const center = Vec.derive(() => ({
      x: (f1.value.x + f2.value.x) / 2,
      y: (f1.value.y + f2.value.y) / 2,
    }));
    const cDist = derive(() => Math.hypot(f2.value.x - f1.value.x, f2.value.y - f1.value.y) / 2);
    const rot = derive(() => Math.atan2(f2.value.y - f1.value.y, f2.value.x - f1.value.x));

    // ── Confocal ellipses ────────────────────────────────────────
    for (const m of ELLIPSE_MULTS) {
      const a = derive(() => cDist.value * m);
      const b = derive(() => {
        const c = cDist.value;
        const av = a.value;
        return Math.sqrt(Math.max(0, av * av - c * c));
      });
      s(ellipse(center, a, b, rot, { thin: true, opacity: 0.22 }));
    }

    // Build one hyperbola branch as a Curve of line segments,
    // parametric in t ∈ [−HYP_T, HYP_T].
    const hypBranch = (
      mult: () => number,
      side: () => 1 | -1,
      opacity: number,
      strokeWidth?: number,
      stroke?: string,
    ) =>
      curve(
        () => {
          const c = cDist.value;
          const m = mult();
          const a = c * m;
          const b = Math.sqrt(Math.max(0, c * c - a * a));
          const ct = center.value;
          const rotV = rot.value;
          const cosR = Math.cos(rotV);
          const sinR = Math.sin(rotV);
          const sign = side();
          const segs: CurveSegment[] = [];
          let prev: V | null = null;
          for (let i = 0; i <= HYP_N; i++) {
            const t = (i / HYP_N) * 2 * HYP_T - HYP_T;
            const xL = sign * a * Math.cosh(t);
            const yL = b * Math.sinh(t);
            const p = { x: ct.x + xL * cosR - yL * sinR, y: ct.y + xL * sinR + yL * cosR };
            if (prev) segs.push({ kind: "line", from: prev, to: p });
            prev = p;
          }
          return segs;
        },
        { thin: strokeWidth === undefined, strokeWidth, opacity, stroke },
      );

    // ── Confocal hyperbolas (background family) ──────────────────
    for (const m of HYP_MULTS) {
      s(
        hypBranch(
          () => m,
          () => 1,
          0.22,
        ),
      );
      s(
        hypBranch(
          () => m,
          () => -1,
          0.22,
        ),
      );
    }

    // ── Probe → confocal coordinates → highlighted pair ──────────
    const r1 = derive(() => Math.hypot(probe.value.x - f1.value.x, probe.value.y - f1.value.y));
    const r2 = derive(() => Math.hypot(probe.value.x - f2.value.x, probe.value.y - f2.value.y));

    // Ellipse through probe: 2a_e = r1 + r2.
    const aE = derive(() => (r1.value + r2.value) / 2);
    const bE = derive(() => {
      const c = cDist.value;
      const a = aE.value;
      return Math.sqrt(Math.max(0, a * a - c * c));
    });
    s(ellipse(center, aE, bE, rot, { stroke: "#5b8def", strokeWidth: 1.8 }));

    // Hyperbola branch through probe: 2a_h = |r1 − r2|. Sign of
    // (r2 − r1) selects which branch (the one closer to f1 is the
    // −x branch in the rotated frame).
    const aHmult = derive(() => Math.abs(r1.value - r2.value) / 2 / cDist.value);
    const hypSide = derive<1 | -1>(() => (r2.value > r1.value ? -1 : 1));
    s(
      hypBranch(
        () => aHmult.value,
        () => hypSide.value,
        1,
        1.8,
        "#e25c5c",
      ),
    );

    // ── Focal radii (probe → each focus) ─────────────────────────
    s(
      line(probe, f1, { thin: true, opacity: 0.55 }),
      line(probe, f2, { thin: true, opacity: 0.55 }),
    );

    // ── Handles ──────────────────────────────────────────────────
    s(handle(f1, { r: 7 }), handle(f2, { r: 7 }), handle(probe, { r: 8, fill: "#5b8def" }));

    s(
      label(
        view.top.down(20),
        "drag a focus or the blue probe — confocal ellipse + hyperbola track in real time",
      ),
      label(
        view.bottom.up(16),
        "5 ellipses (a > c) ⊥ 4 hyperbolas (a < c) · 2a_e = r₁+r₂ · 2a_h = |r₁−r₂|",
        { size: 10 },
      ),
    );
  }
}
