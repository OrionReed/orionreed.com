// md-sketchpad.ts — sketchpad-style geometric constraints with a
// runtime-toggleable brace.
//
// Four corners of a quadrilateral with four side constraints. With
// just those, the figure has one internal degree of freedom and
// flexes when dragged — a 4-bar linkage. Add a diagonal distance
// constraint and the remaining DOF is killed: the quad becomes a
// rigid body that only translates and rotates. `addWhile(braced, …)`
// flips the diagonal in and out reactively; click the dot riding on
// the diagonal to toggle.

import { constraints, distance, pin } from "@minim/constraints";
import {
  circle,
  Diagram,
  derive,
  handle,
  label,
  line,
  Mount,
  signal,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

type WVec = Writable<Vec>;

const BRACED_FILL = "#5b8def";
const UNBRACED_FILL = "#d8dde6";

export class MdSketchpad extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const A = vec(cx - 80, cy - 60);
    const B = vec(cx + 80, cy - 60);
    const C = vec(cx + 80, cy + 60);
    const D = vec(cx - 80, cy + 60);

    const diagLen = Math.hypot(160, 120);

    const cluster = constraints({ iterations: 20 });
    cluster.add(distance(A, B, 160), distance(B, C, 120), distance(C, D, 160), distance(D, A, 120));

    const braced = signal(true);
    cluster.addWhile(braced, distance(A, C, diagLen));

    s(line(A, B));
    s(line(B, C));
    s(line(C, D));
    s(line(D, A));

    // The diagonal renders thin-dashed as a ghost when off and at full
    // opacity when on, so the toggle dot always has a line to ride.
    s(
      line(A, C, {
        thin: true,
        dashed: true,
        opacity: derive(() => (braced.value ? 0.65 : 0.2)),
      }),
    );

    const dotPos = A.lerp(C, 0.5);
    const dot = s(
      circle(dotPos, 7, {
        fill: derive(() => (braced.value ? BRACED_FILL : UNBRACED_FILL)),
        stroke: "#1a1a1a",
        thin: true,
      }),
    );
    dot.el.style.cursor = "pointer";
    dot.on("click", () => {
      braced.value = !braced.value;
    });

    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>]> = [
      [A, s(handle(A))],
      [B, s(handle(B))],
      [C, s(handle(C))],
      [D, s(handle(D))],
    ];
    for (const [sig, h] of handles) {
      cluster.addWhile(h.dragging, pin(sig));
    }

    s(
      label(view.top.down(20), "drag any corner — click the dot to add or remove the brace"),
      label(
        view.bottom.up(16),
        "4 side constraints + 1 toggleable diagonal · addWhile flips structural shape at runtime",
        { size: 10 },
      ),
    );
  }
}
