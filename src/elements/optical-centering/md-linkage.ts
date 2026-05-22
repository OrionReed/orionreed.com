// md-linkage.ts — Theo Jansen leg.
//
// 1 crank + 11 bars → walking gait. Forward kinematics is 5 cascaded
// 2-circle intersections (`dyad`); no global solver needed. Drag the
// blue crank or the red foot — argminVec inverts the chain through θ.

import {
  Anchor,
  argminVec,
  type CurveSegment,
  circle,
  computed,
  curve,
  Diagram,
  drive,
  handle,
  label,
  line,
  Mount,
  type Num,
  num,
  type Of,
  polar,
  Vec,
  type Writable,
} from "../../minim";

type V = Of<Vec>;

const TAU = Math.PI * 2;

type DyadOpts = { branch: 1 | -1 } | { away: V };

/** Joint at distance r1 from c1, r2 from c2. `branch` picks chord side;
 *  `away` picks the solution farther from a reference point. */
function dyad(c1: V, r1: number, c2: V, r2: number, opts: DyadOpts): V {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || d > r1 + r2 || d < Math.abs(r1 - r2)) return c1;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1.x + (a * dx) / d;
  const my = c1.y + (a * dy) / d;
  const ox = (h * dy) / d;
  const oy = (h * dx) / d;
  if ("away" in opts) {
    const p1 = { x: mx + ox, y: my - oy };
    const p2 = { x: mx - ox, y: my + oy };
    const ref = opts.away;
    const d1 = (p1.x - ref.x) ** 2 + (p1.y - ref.y) ** 2;
    const d2 = (p2.x - ref.x) ** 2 + (p2.y - ref.y) ** 2;
    return d1 > d2 ? p1 : p2;
  }
  return { x: mx + opts.branch * ox, y: my - opts.branch * oy };
}

// Theo Jansen's "holy numbers" — 13 ratios that produce the gait.
// Treated as pixels via SC.
const HN = {
  a: 38, b: 41.5, c: 39.3, d: 40.1, e: 55.8, f: 39.4,
  g: 36.7, h: 65.7, i: 49, j: 50, k: 61.9, l: 7.8, m: 15,
};
const SC = 2.4;

export class MdLinkage extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 480);
    const { a, b, c, d, e, f, g, h, i, j, k, l, m } = HN;

    const O = view.center.up(70);
    const P = O.left(a * SC).up(l * SC);

    const theta = num(0).cyclic(TAU);
    const A = polar(O, m * SC, theta, "circular");

    // The whole leg in one declaration. Same function provides both
    // the reactive scene-graph nodes and the pure forward map for
    // argminVec to invert at the foot.
    const leg = (Av: V, Pv: V) => {
      const B = dyad(Pv, b * SC, Av, j * SC, { branch: +1 });
      const C = dyad(Pv, c * SC, Av, k * SC, { branch: -1 });
      const D = dyad(B, d * SC, C, e * SC, { away: Pv });
      const E = dyad(C, h * SC, D, i * SC, { away: B });
      const F = dyad(D, g * SC, E, f * SC, { away: C });
      return { B, C, D, E, F };
    };

    const aFwd = (t: number): V => ({
      x: O.value.x + m * SC * Math.cos(t),
      y: O.value.y + m * SC * Math.sin(t),
    });

    const sol = computed(() => leg(A.value, P.value));
    const B = computed(() => sol.value.B, Vec);
    const C = computed(() => sol.value.C, Vec);
    const D = computed(() => sol.value.D, Vec);
    const E = computed(() => sol.value.E, Vec);

    // Pre-computed gait — used both for the trace render *and* as
    // argminVec's workspace clamp. Same idiom as md-ik's clampToDisc
    // (rank-deficient inverse → project the drag target into the
    // reachable workspace before the Newton step). Here the workspace
    // is a 1D closed curve rather than a 2D disc.
    const N = 120;
    const gait: V[] = Array.from({ length: N + 1 }, (_, n) =>
      leg(aFwd((n / N) * TAU), P.value).F,
    );
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

    const F = argminVec(
      [theta as unknown as Writable<Num>],
      ([t]) => leg(aFwd(t), P.value).F,
      [1],
      { clampTarget: projectOntoGait },
    );

    const traceSegs: CurveSegment[] = [];
    for (let n = 1; n <= N; n++) {
      traceSegs.push({ kind: "line", from: gait[n - 1], to: gait[n] });
    }
    s(curve(traceSegs, { thin: true, opacity: 0.6, stroke: "#e25c5c" }));

    s(circle(O, m * SC, { thin: true, dashed: true, opacity: 0.25 }));

    s(
      line(P, B, { thin: true }),
      line(A, B, { thin: true }),
      line(P, C, { thin: true }),
      line(A, C, { thin: true }),
      line(B, D, { thin: true }),
      line(C, D, { thin: true }),
      line(C, E, { thin: true }),
      line(D, E, { thin: true }),
      line(D, F, { thin: true }),
      line(E, F, { thin: true }),
      line(O, A, { thin: true, opacity: 0.5 }),
    );

    s(circle(O, 4, { fill: true }), circle(P, 4, { fill: true }));
    for (const joint of [B, C, D, E]) {
      s(circle(joint, 3, { fill: "var(--bg-color, white)", thin: true }));
    }

    const aH = s(handle(A, { fill: "#5b8def", r: 7 }));
    const fH = s(handle(F, { fill: "#e25c5c", r: 7 }));

    const omega = TAU * 0.18;
    this.anim.start(
      drive(tick => {
        if (aH.dragging.value || fH.dragging.value) return;
        theta.value = theta.peek() + omega * tick.dt;
      }),
    );

    s(
      label(view.top.down(20), "drag the blue crank or the red foot — Theo Jansen's leg", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "5 cascaded `dyad`s · 11 bar-length constraints · the foot trace IS the gait curve",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
