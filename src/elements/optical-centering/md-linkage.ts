// md-linkage.ts — Hoeken's straight-line linkage (1926).
//
// 4 bars + 1 crank. The tracer T is collinear with the coupler at
// twice its length from A; over ~half the cycle T moves along a
// nearly-straight horizontal line. Single `dyad` in the cascade,
// no singular configurations through the revolution.

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

// Hoeken's canonical proportions: |OA| : |OP| : |AB| : |BP| = 1 : 2 : 2.5 : 2.5.
// Tracer T is collinear with A→B at twice the AB length from A.
const HK = { crank: 1, frame: 2, coupler: 2.5, rocker: 2.5 };
const SC = 50;

export class MdLinkage extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 380);
    const { crank, frame, coupler, rocker } = HK;

    const O = view.center.up(40).left((frame * SC) / 2);
    const P = O.right(frame * SC);

    const theta = num(0).cyclic(TAU);
    const A = polar(O, crank * SC, theta, "circular");

    const B = computed(
      () => dyad(A.value, coupler * SC, P.value, rocker * SC, { branch: +1 }),
      Vec,
    );

    // Forward map θ → T. Reused for the reactive scene-graph node, the
    // gait pre-render, and the argminVec inverse.
    const tFwd = (t: number): V => {
      const Av = {
        x: O.value.x + crank * SC * Math.cos(t),
        y: O.value.y + crank * SC * Math.sin(t),
      };
      const Bv = dyad(Av, coupler * SC, P.value, rocker * SC, { branch: +1 });
      return { x: 2 * Bv.x - Av.x, y: 2 * Bv.y - Av.y };
    };

    const N = 120;
    const gait: V[] = Array.from({ length: N + 1 }, (_, n) => tFwd((n / N) * TAU));
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

    const T = argminVec([theta as unknown as Writable<Num>], ([t]) => tFwd(t), [1], {
      clampTarget: projectOntoGait,
    });

    const traceSegs: CurveSegment[] = [];
    for (let n = 1; n <= N; n++) {
      traceSegs.push({ kind: "line", from: gait[n - 1], to: gait[n] });
    }
    s(curve(traceSegs, { thin: true, opacity: 0.6, stroke: "#e25c5c" }));

    s(circle(O, crank * SC, { thin: true, dashed: true, opacity: 0.25 }));

    s(
      line(O, A, { thin: true, opacity: 0.5 }),
      line(A, B, { thin: true }),
      line(B, T, { thin: true }),
      line(P, B, { thin: true }),
    );

    s(circle(O, 4, { fill: true }), circle(P, 4, { fill: true }));
    s(circle(B, 3, { fill: "var(--bg-color, white)", thin: true }));

    const aH = s(handle(A, { fill: "#5b8def", r: 7 }));
    const tH = s(handle(T, { fill: "#e25c5c", r: 7 }));

    const omega = TAU * 0.18;
    this.anim.start(
      drive(tick => {
        if (aH.dragging.value || tH.dragging.value) return;
        theta.value = theta.peek() + omega * tick.dt;
      }),
    );

    s(
      label(view.top.down(20), "drag the blue crank or the red tracer — Hoeken's linkage", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "1 dyad · 4 bars convert circular to near-straight-line motion (1926)",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
