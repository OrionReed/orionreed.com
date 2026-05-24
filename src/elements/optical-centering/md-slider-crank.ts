// md-slider-crank.ts — the engine of every internal-combustion engine.
//
// One rotating crank arm `O1—A`, one rigid connecting rod `A—B`,
// one piston `B` constrained to slide along a horizontal guide.
// Three constraints, two pinned grounds, one slide axis defined
// by two more pinned anchors.
//
// Both the crank tip and the piston are draggable, but neither is
// pinned during drag — the drag callback writes the signal to the
// cursor, then the cluster's effect runs `solver.step()` which
// projects the cell back onto the constraint manifold. With the
// hard-distance penalty dominating the mass term in the local
// Newton, the shape "slips" along the closest valid configuration.

import { constraints, collinear, distance } from "@minim/constraints";
import { Anchor, circle, Diagram, drag, label, line, Mount, rect, vec } from "../../minim";

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

    const cluster = constraints({ iterations: 24 });
    cluster.add(distance(O1, A, CRANK));
    cluster.add(distance(A, B, ROD));
    cluster.add(collinear(B, guide1, guide2));
    cluster.pin(O1);
    cluster.pin(guide1);
    cluster.pin(guide2);

    s(circle(O1, CRANK, { thin: true, opacity: 0.18 }));
    s(line(guide1, guide2, { thin: true, opacity: 0.25 }));
    s(line(O1, A, { thin: false }));
    s(line(A, B, { thin: false }));
    s(circle(O1, 5, { fill: true }));

    const aH = s(circle(A, 8, { fill: "#e25c5c" }));
    aH.el.style.cursor = "grab";
    drag(aH, A);

    const piston = s(rect(B, 56, 20, { fill: "#5b8def", corner: 3 }));
    piston.el.style.cursor = "ew-resize";
    drag(piston, B);

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
