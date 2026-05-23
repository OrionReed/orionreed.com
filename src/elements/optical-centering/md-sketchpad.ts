// md-sketchpad.ts — sketchpad-style geometric constraints.
//
// Four points wired up with three distance constraints and one
// perpendicularity constraint. Drag any handle: the constraint
// engine re-solves on every write and the rest of the figure
// reflows to keep all four constraints satisfied.

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
import { Cluster, distance, rightAngle } from "@minim/constraints";

type WVec = Writable<Vec>;

export class MdSketchpad extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const A = vec(cx - 100, cy - 60);
    const B = vec(cx + 60, cy - 60);
    const C = vec(cx + 60, cy + 60);
    const D = vec(cx + 140, cy + 60);

    const cluster = new Cluster({ iterations: 24 });
    distance(cluster, A, B, 160);
    distance(cluster, B, C, 120);
    distance(cluster, C, D, 80);
    rightAngle(cluster, A, B, C);

    s(line(A, B));
    s(line(B, C));
    s(line(C, D));
    s(circle(B, 8, { thin: true, opacity: 0.45 }));

    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>]> = [
      [A, s(handle(A))],
      [B, s(handle(B))],
      [C, s(handle(C))],
      [D, s(handle(D))],
    ];
    for (const [sig, h] of handles) {
      effect(() => (h.dragging.value ? cluster.pin(sig) : undefined));
    }

    s(
      label(view.top.down(20), "drag any corner — bar lengths and the right angle stay satisfied", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "3 distance + 1 perpendicular constraints in a Cluster",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
