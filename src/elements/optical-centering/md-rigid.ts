// md-rigid.ts — distance-only rigidity.
//
// Four corners of a quadrilateral. With just the four side
// constraints it's a 4-bar linkage — one internal degree of
// freedom, the shape flexes when dragged. Toggle the diagonal:
// that one extra distance constraint kills the remaining DOF
// and the quad becomes a rigid body that only translates and
// rotates as a whole.

import {
  Anchor,
  circle,
  Diagram,
  effect,
  handle,
  label,
  line,
  Mount,
  signal,
  vec,
  type Vec,
  type Writable,
} from "../../minim";
import { Cluster, distance } from "@minim/constraints";

type WVec = Writable<Vec>;

export class MdRigid extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const A = vec(cx - 80, cy - 60);
    const B = vec(cx + 80, cy - 60);
    const C = vec(cx + 80, cy + 60);
    const D = vec(cx - 80, cy + 60);

    const cluster = new Cluster({ iterations: 16 });
    distance(cluster, A, B, 160);
    distance(cluster, B, C, 120);
    distance(cluster, C, D, 160);
    distance(cluster, D, A, 120);
    const diag = distance(cluster, A, C, Math.hypot(160, 120));

    // Diagonal toggle: dispose / recreate the brace constraint.
    const braced = signal(true);
    let current: ReturnType<typeof distance> | undefined = diag;
    effect(() => {
      if (braced.value && current === undefined) {
        current = distance(cluster, A, C, Math.hypot(160, 120));
      } else if (!braced.value && current !== undefined) {
        current.dispose();
        current = undefined;
        cluster.update();
      }
    });

    s(line(A, B));
    s(line(B, C));
    s(line(C, D));
    s(line(D, A));
    s(line(A, C, { thin: true, opacity: 0.45, dashed: true }));

    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>]> = [
      [A, s(handle(A))],
      [B, s(handle(B))],
      [C, s(handle(C))],
      [D, s(handle(D))],
    ];
    for (const [sig, h] of handles) {
      effect(() => (h.dragging.value ? cluster.pin(sig) : undefined));
    }

    // Click-to-toggle on the diagonal label.
    const toggle = s(
      label(view.bottom.up(38), () => (braced.value ? "rigid (diagonal on)" : "flexible (diagonal off)"), {
        size: 12,
        align: Anchor.Center,
        opacity: 0.85,
      }),
    );
    toggle.el.style.cursor = "pointer";
    toggle.el.addEventListener("click", () => {
      braced.value = !braced.value;
    });

    s(
      label(view.top.down(20), "drag any corner — toggle the diagonal to see the difference", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "4 side constraints + 1 toggleable diagonal — same Cluster, structural change at runtime",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
