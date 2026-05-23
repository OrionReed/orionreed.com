// md-slider-crank.ts — the engine of every internal-combustion engine.
//
// One rotating crank arm `O1—A`, one rigid connecting rod `A—B`,
// one piston `B` constrained to slide along a horizontal guide.
// Three constraints, two pinned grounds, one slide axis defined
// by two more pinned anchors. Drag the crank tip and the piston
// reciprocates in perfect kinematic sync — no closed-form
// inverse, no special-case logic, just constraints in a cluster.

import {
  Anchor,
  circle,
  Diagram,
  effect,
  handle,
  label,
  line,
  Mount,
  rect,
  vec,
} from "../../minim";
import { Cluster, collinear, distance } from "@minim/constraints";

const CRANK = 50;
const ROD = 130;

export class MdSliderCrank extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const O1 = vec(cx - 80, cy);
    const A = vec(cx - 80, cy - CRANK);
    const B = vec(cx - 80 + Math.sqrt(ROD * ROD - CRANK * CRANK), cy);

    // Two anchors fix the horizontal slide axis through O1's y.
    const guide1 = vec(cx + 30, cy);
    const guide2 = vec(cx + 200, cy);

    const cluster = new Cluster({ iterations: 24 });
    distance(cluster, O1, A, CRANK);
    distance(cluster, A, B, ROD);
    collinear(cluster, B, guide1, guide2);
    cluster.pin(O1);
    cluster.pin(guide1);
    cluster.pin(guide2);

    // Render the crank's reachable circle (debug-y).
    s(circle(O1, CRANK, { thin: true, opacity: 0.18 }));
    // Slide guide.
    s(line(guide1, guide2, { thin: true, opacity: 0.25 }));
    // Crank arm + connecting rod.
    s(line(O1, A, { thin: false }));
    s(line(A, B, { thin: false }));
    // Pivots and piston body.
    s(circle(O1, 5, { fill: true }));
    const piston = s(rect(B, 50, 18, { fill: "#5b8def", corner: 3 }));
    piston.el.style.pointerEvents = "none";

    const aH = s(handle(A, { fill: "#e25c5c", r: 7 }));
    effect(() => (aH.dragging.value ? cluster.pin(A) : undefined));

    s(
      label(view.top.down(20), "drag the red crank tip — the piston follows on the guide", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "distance(crank) · distance(rod) · collinear(piston, guide₁, guide₂)",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
