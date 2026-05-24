// md-equation.ts — the constraint solver run as an algebraic equation solver.
//
// No geometry, no positions, no physics — three plain `Num` cells
// `a`, `b`, `c` and a single `generic` constraint enforcing
// `a² + b² = c²`. Drag any of the three sliders and the other two
// rebalance to satisfy the equation. AVBD's Newton step on a 1×3
// underdetermined system picks the (a, b, c) on the constraint
// surface closest to the current values, which feels like
// "redistribute the violation among the un-pinned cells."

import { Cluster, clamp, generic } from "@minim/constraints";
import {
  Anchor,
  circle,
  Diagram,
  drag,
  effect,
  label,
  line,
  Mount,
  num,
  signal,
  Vec,
} from "../../minim";

type V = { x: number; y: number };

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

    const cluster = new Cluster({ iterations: 24 });
    cluster.add(
      generic([a, b, c], 1, (pos, out) => {
        const av = pos[0]![0]!;
        const bv = pos[1]![0]!;
        const cv = pos[2]![0]!;
        out[0]! = av * av + bv * bv - cv * cv;
      }),
    );
    cluster.add(clamp(a, 0.5, A_MAX));
    cluster.add(clamp(b, 0.5, A_MAX));
    cluster.add(clamp(c, 0.5, C_MAX));

    const tracks = [
      { sig: a, max: A_MAX, color: "#5b8def", label: "a", y: 130 },
      { sig: b, max: A_MAX, color: "#e25c5c", label: "b", y: 195 },
      { sig: c, max: C_MAX, color: "#f5a623", label: "c", y: 260 },
    ];

    const fixedV = (x: number, y: number) =>
      Vec.lens(
        () => ({ x, y }),
        () => {},
      );

    for (const t of tracks) {
      s(line(fixedV(trackX0, t.y), fixedV(trackX1, t.y), { thin: true, opacity: 0.4 }));
      s(line(fixedV(trackX0, t.y - 6), fixedV(trackX0, t.y + 6), { thin: true, opacity: 0.5 }));

      const handlePos = Vec.lens(
        () => ({ x: trackX0 + (t.sig.value / t.max) * TRACK_LEN, y: t.y }),
        (v: V) => {
          const v01 = (v.x - trackX0) / TRACK_LEN;
          (t.sig as unknown as { value: number }).value = v01 * t.max;
        },
      );

      const dot = s(circle(handlePos, 9, { fill: t.color }));
      dot.el.style.cursor = "ew-resize";
      const dragging = signal(false);
      drag(dot, handlePos, dragging);
      effect(() => (dragging.value ? cluster.pin(t.sig) : undefined));

      s(
        label(fixedV(trackX0 - 30, t.y + 4), t.label, {
          size: 16,
          align: Anchor.Center,
          opacity: 0.85,
        }),
      );
      s(
        label(fixedV(trackX1 + 40, t.y + 4), () => t.sig.value.toFixed(2), {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        }),
      );
    }

    s(
      label(
        view.top.down(20),
        "drag any handle — the other two redistribute to keep a² + b² = c²",
        {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        },
      ),
      label(view.bottom.up(16), "three Num cells · one generic constraint · no geometry", {
        size: 10,
        align: Anchor.Center,
        opacity: 0.5,
      }),
    );
  }
}
