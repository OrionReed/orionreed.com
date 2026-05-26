// md-equation.ts — the constraint solver run as an algebraic equation solver.
//
// No geometry, no positions, no physics — three plain `Num` cells
// `a`, `b`, `c` and a single `generic` constraint enforcing
// `a² + b² = c²`. Drag any of the three sliders and the other two
// rebalance to satisfy the equation. AVBD's Newton step on a 1×3
// underdetermined system picks the (a, b, c) on the constraint
// surface closest to the current values, which feels like
// "redistribute the violation among the un-pinned cells."

import { clamp, constraints, generic, pin } from "@minim/constraints";
import { Anchor, Diagram, handle, label, line, Mount, Num, num, range, vec } from "../../minim";

const TRACK_LEN = 360;
const A_MAX = 10;
const C_MAX = 15;

export class MdEquation extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const trackX0 = cx - TRACK_LEN / 2;
    const trackX1 = cx + TRACK_LEN / 2;

    const a = num(3);
    const b = num(4);
    const c = num(5);

    const cluster = constraints({ iterations: 24 });
    cluster.add(
      generic([a, b, c], 1, (pos, out) => {
        const av = pos[0]![0]!;
        const bv = pos[1]![0]!;
        const cv = pos[2]![0]!;
        out[0]! = av * av + bv * bv - cv * cv;
      }),
      clamp(a, 0.5, A_MAX),
      clamp(b, 0.5, A_MAX),
      clamp(c, 0.5, C_MAX),
    );

    const tracks = [
      { sig: a, max: A_MAX, color: "#5b8def", label: "a", y: 130 },
      { sig: b, max: A_MAX, color: "#e25c5c", label: "b", y: 195 },
      { sig: c, max: C_MAX, color: "#f5a623", label: "c", y: 260 },
    ];

    for (const t of tracks) {
      s(line(vec(trackX0, t.y), vec(trackX1, t.y), { thin: true, opacity: 0.4 }));
      s(line(vec(trackX0, t.y - 6), vec(trackX0, t.y + 6), { thin: true, opacity: 0.5 }));

      // Chained invertible lens: pixel ↔ unit-value via the bidirectional
      // `range.slider`. Writing the knob's x writes back through to `t.sig`;
      // y is locked at the track row via `Num.pin`.
      const knobX = range(trackX0, trackX1).slider(t.sig.scale(1 / t.max));
      const h = s(handle(vec(knobX, Num.pin(t.y)), { r: 9, fill: t.color, cursor: "ew-resize" }));
      cluster.addWhile(h.dragging, pin(t.sig));

      s(
        label(vec(trackX0 - 30, t.y + 4), t.label, {
          size: 16,
          align: Anchor.Center,
          opacity: 0.85,
        }),
      );
      s(
        label(vec(trackX1 + 40, t.y + 4), () => t.sig.value.toFixed(2), {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        }),
      );
    }

    s(
      label(view.top.down(20), "drag any handle — the other two redistribute to keep a² + b² = c²"),
      label(view.bottom.up(16), "three Num cells · one generic constraint · no geometry", {
        size: 10,
      }),
    );
  }
}
