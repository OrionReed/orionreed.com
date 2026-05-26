// md-prop-geom.ts — bidirectional geometric construction via
// propagator network. A triangle with centroid + side-midpoints,
// where every relation runs in both directions:
//
//   - drag any vertex → centroid + midpoints derive
//   - drag the centroid → all three vertices translate together
//   - drag any midpoint → the corresponding edge translates
//
// Six propagator declarations, no manual residuals, no solver
// configuration. Compare to the AVBD `Constraints` version: same
// shape, same feel, but propagators handle the few-relations
// case in a single pass with exact arithmetic.

import { propagators, vCentroid, vMidpoint } from "@minim/propagators";
import { Anchor, Diagram, handle, label, line, Mount, vec } from "../../minim";

const VERT = "#5b8def";
const CENT = "#f5a623";
const MID = "#86b966";

export class MdPropGeom extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 400);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Triangle vertices.
    const A = vec(cx - 140, cy + 80);
    const B = vec(cx + 140, cy + 80);
    const C = vec(cx, cy - 100);

    // Derived: centroid + per-side midpoints.
    const G = vec(0, 0);
    const Mab = vec(0, 0);
    const Mbc = vec(0, 0);
    const Mca = vec(0, 0);

    const p = propagators();
    p.add(vCentroid(G, A, B, C));
    p.add(vMidpoint(A, B, Mab));
    p.add(vMidpoint(B, C, Mbc));
    p.add(vMidpoint(C, A, Mca));

    // Triangle sides.
    s(
      line(A, B, { thin: true, opacity: 0.6 }),
      line(B, C, { thin: true, opacity: 0.6 }),
      line(C, A, { thin: true, opacity: 0.6 }),

      // Medians (centroid to midpoint of opposite side).
      line(G, Mab, { thin: true, opacity: 0.25 }),
      line(G, Mbc, { thin: true, opacity: 0.25 }),
      line(G, Mca, { thin: true, opacity: 0.25 }),

      // Vertices (draggable).
      handle(A, { fill: VERT, r: 7 }),
      handle(B, { fill: VERT, r: 7 }),
      handle(C, { fill: VERT, r: 7 }),

      // Centroid (draggable).
      handle(G, { fill: CENT, r: 8 }),

      // Midpoints (draggable).
      handle(Mab, { fill: MID, r: 5 }),
      handle(Mbc, { fill: MID, r: 5 }),
      handle(Mca, { fill: MID, r: 5 }),

      label(
        view.top.down(20),
        "drag any vertex • centroid (orange) follows • drag centroid → triangle translates",
        { size: 12, align: Anchor.Center, opacity: 0.7 },
      ),
      label(
        view.bottom.up(16),
        "vCentroid · vMidpoint — bidirectional propagators on Vec signals",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
