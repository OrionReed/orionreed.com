// md-incidence.ts — sketchpad / CAD-style construction.
//
// A draggable circle (centered on a moving anchor), a draggable
// guide line through two anchors, and a rigid bracket whose two
// outer vertices are constrained to the circle and the line
// respectively. Drag the anchors and the loci move; drag the free
// inner vertex and the bracket articulates while keeping its
// vertices on their respective loci.

import { attachWhile, collinear, constraints, distance, equalDist, onCircle, pin, rightAngle } from "@minim/constraints";
import {
  Anchor,
  circle,
  Diagram,
  effect,
  handle,
  label,
  line,
  Mount,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

type WVec = Writable<Vec>;

const RADIUS = 65;
const BAR = 70;

export class MdIncidence extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 400);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Locus anchors.
    const center = vec(cx - 140, cy);
    const L1 = vec(cx + 70, cy + 110);
    const L2 = vec(cx + 220, cy - 110);

    // Bracket vertices.
    const P = vec(cx - 140 + RADIUS, cy); // on the circle
    const Q = vec(cx + 145, cy); // on the line
    const M = vec(cx - 30, cy); // free inner vertex

    const cluster = constraints({ iterations: 24 });
    cluster.add(onCircle(P, center, RADIUS));
    cluster.add(collinear(Q, L1, L2));
    cluster.add(distance(P, M, BAR));
    cluster.add(distance(M, Q, BAR));
    cluster.add(equalDist(P, M, M, Q));
    cluster.add(rightAngle(P, M, Q));

    // Render the loci behind everything else.
    s(circle(center, RADIUS, { thin: true, opacity: 0.4 }));
    s(circle(center, 3, { fill: true }));
    s(line(L1, L2, { thin: true, opacity: 0.4 }));

    // Bracket itself — two solid bars meeting at M with a small
    // marker drawn at the right-angle corner.
    s(line(P, M));
    s(line(M, Q));
    s(circle(M, 8, { thin: true, opacity: 0.45 }));

    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>, string]> = [
      [center, s(handle(center, { r: 6 })), "center"],
      [L1, s(handle(L1, { r: 6 })), "L1"],
      [L2, s(handle(L2, { r: 6 })), "L2"],
      [P, s(handle(P, { fill: "#5b8def", r: 7 })), "P"],
      [Q, s(handle(Q, { fill: "#e25c5c", r: 7 })), "Q"],
      [M, s(handle(M, { fill: "#f5a623", r: 7 })), "M"],
    ];
    for (const [sig, h] of handles) {
      attachWhile(cluster, h.dragging, pin(sig));
    }

    s(
      label(
        view.top.down(20),
        "P stays on the circle, Q stays on the line, |PM| = |MQ| at a right angle",
        {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        },
      ),
      label(
        view.bottom.up(16),
        "onCircle · collinear · distance · equalDist · rightAngle — six constraints, one cluster",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
