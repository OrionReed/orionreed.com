// md-fourbar.ts — classic 4-bar linkage as a constraint cluster.
//
// Two ground pivots (pinned), two free joints, three rigid bars.
// The ground itself is implicit: pinning O1 and O2 fixes the
// fourth side of the loop. With three hard distance constraints
// over four DOF (A, B), the mechanism has one internal degree of
// freedom — drag a joint anywhere and the rest of the loop follows.

import { constraints, distance, pin } from "@minim/constraints";
import {
  Anchor,
  circle,
  Diagram,
  handle,
  label,
  line,
  Mount,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

type WVec = Writable<Vec>;

export class MdFourbar extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const O1 = vec(cx - 110, cy + 40);
    const O2 = vec(cx + 110, cy + 40);
    const A = vec(cx - 110, cy - 50);
    const B = vec(cx + 110, cy - 20);

    const crank = 90;
    const rocker = 60;
    const coupler = Math.hypot(B.value.x - A.value.x, B.value.y - A.value.y);

    const cluster = constraints({ iterations: 24 });
    cluster.add(
      distance(O1, A, crank),
      distance(A, B, coupler),
      distance(B, O2, rocker),
      pin(O1),
      pin(O2),
    );

    s(
      line(O1, O2, { thin: true, opacity: 0.18 }),
      line(O1, A),
      line(A, B),
      line(B, O2),
      circle(O1, 4, { fill: true }),
      circle(O2, 4, { fill: true }),
    );

    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>]> = [
      [A, s(handle(A, { fill: "#5b8def", r: 7 }))],
      [B, s(handle(B, { fill: "#e25c5c", r: 7 }))],
    ];
    for (const [sig, h] of handles) {
      cluster.addWhile(h.dragging, pin(sig));
    }

    s(
      label(
        view.top.down(20),
        "drag the blue or red joint — the loop articulates through its one DOF",
        {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        },
      ),
      label(
        view.bottom.up(16),
        "3 distance constraints + 2 pinned grounds — 1 internal degree of freedom",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
