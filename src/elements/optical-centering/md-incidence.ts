// md-incidence.ts — points constrained to geometric loci.
//
// The blue point is constrained on a circle of fixed radius around
// a draggable center; the red point is constrained collinear with
// two draggable anchors. Each constrained point can be dragged
// freely — the solver projects the user's cursor onto the locus
// (closest point on circle / line). Drag the anchors and the loci
// move with them; the constrained points slide.

import {
  Anchor,
  circle,
  Diagram,
  effect,
  handle,
  label,
  line,
  Mount,
  vec,
  type Vec,
  type Writable,
} from "../../minim";
import { Cluster, collinear, onCircle } from "@minim/constraints";

type WVec = Writable<Vec>;

const RADIUS = 70;

export class MdIncidence extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Circle locus: center C plus a free point P on the circle.
    const center = vec(cx - 130, cy);
    const onPt = vec(cx - 130 + RADIUS, cy);
    s(circle(center, RADIUS, { thin: true, opacity: 0.4 }));
    s(circle(center, 3, { fill: true }));

    // Line locus: anchors L1, L2 plus a free point Q on line(L1, L2).
    const L1 = vec(cx + 30, cy + 80);
    const L2 = vec(cx + 200, cy - 80);
    const onLine = vec(cx + 100, cy);
    s(line(L1, L2, { thin: true, opacity: 0.4 }));

    const cluster = new Cluster({ iterations: 24 });
    onCircle(cluster, onPt, center, RADIUS);
    collinear(cluster, onLine, L1, L2);

    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>]> = [
      [center, s(handle(center, { r: 6 }))],
      [onPt, s(handle(onPt, { fill: "#5b8def", r: 7 }))],
      [L1, s(handle(L1, { r: 6 }))],
      [L2, s(handle(L2, { r: 6 }))],
      [onLine, s(handle(onLine, { fill: "#e25c5c", r: 7 }))],
    ];
    for (const [sig, h] of handles) {
      effect(() => (h.dragging.value ? cluster.pin(sig) : undefined));
    }

    s(
      label(view.top.down(20), "blue stays on the circle, red stays on the line — drag any handle", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(view.bottom.up(16), "onCircle(P, center, r) · collinear(P, L1, L2)", {
        size: 10,
        align: Anchor.Center,
        opacity: 0.5,
      }),
    );
  }
}
