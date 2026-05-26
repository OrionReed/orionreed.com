// md-figure8.ts — circles constrained to slide along a figure-8 curve.
//
// Each circle has two cells: a Vec position `P` (rendered) and a
// scalar parameter `t`. A `generic` constraint locks them
// together via the Lissajous map `P = (R·sin t, R·sin 2t / 2)`.
// Pairwise `gap` keeps the circles from overlapping in 2D. Drag
// any circle: the cluster finds the (t, P) on the curve closest
// to the cursor (typically by sliding along the curve, until a
// branch flip near the self-intersection at the origin).

import { constraints, gap, generic } from "@minim/constraints";
import {
  Anchor,
  Diagram,
  handle,
  label,
  Mount,
  num,
  Path,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

type WVec = Writable<Vec>;
type WNum = Writable<import("../../minim").Num>;

const N = 7;
const R = 13;
const A = 140;
const COLORS = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321", "#9b59b6", "#1abc9c", "#e67e22"];

export class MdFigure8 extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const curve = (t: number): { x: number; y: number } => ({
      x: cx + A * Math.sin(t),
      y: cy + (A * Math.sin(2 * t)) / 2,
    });

    // Static trace of the figure-8 for the background.
    const trace: Vec[] = [];
    for (let i = 0; i <= 240; i++) {
      const t = (i / 240) * 2 * Math.PI;
      trace.push(vec(curve(t).x, curve(t).y));
    }
    s(new Path(trace, { thin: true, opacity: 0.35, closed: true }));

    const positions: WVec[] = [];
    const params: WNum[] = [];
    const cluster = constraints({ iterations: 16 });

    for (let i = 0; i < N; i++) {
      const t0 = (i / N) * 2 * Math.PI;
      const p = curve(t0);
      const P = vec(p.x, p.y);
      const t = num(t0);
      positions.push(P);
      params.push(t);

      cluster.add(
        generic([t, P], 2, (pos, out) => {
          const tt = pos[0]![0]!;
          const want = curve(tt);
          out[0]! = pos[1]![0]! - want.x;
          out[1]! = pos[1]![1]! - want.y;
        }),
      );
    }
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) cluster.add(gap(positions[i]!, positions[j]!, 2 * R));
    }

    for (let i = 0; i < N; i++) {
      s(handle(positions[i]!, { r: R, fill: COLORS[i % COLORS.length]! }));
    }

    s(
      label(
        view.top.down(20),
        "drag any circle — it slides along the figure-8, others scoot aside",
        {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        },
      ),
      label(
        view.bottom.up(16),
        `${N} circles · per-shape (t, P) coupled via generic · pairwise gap`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
