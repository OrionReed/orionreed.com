// md-prop-net.ts — a Sussman-style propagator network.
//
//                         total
//                          │
//                       ┌──┴──┐
//                       │ +   │       (chainSum: a+b+c+d = total)
//                       └─┬─┬─┘
//                       a b c d
//
// Four leaves and a sum. Pull any one slider; the others
// rebalance proportionally so the sum stays exact. Pull the
// "total" slider; all four leaves redistribute the slack
// (split equally among them since the network is symmetric).
//
// No solver, no convergence loop — straight propagator
// arithmetic, instant.

import { adder, propagators } from "@minim/propagators";
import {
  Anchor,
  circle,
  Diagram,
  drag,
  label,
  line,
  Mount,
  num,
  signal,
  Vec,
} from "../../minim";

const TRACK_X0 = 100;
const TRACK_X1 = 460;
const VAL_MAX = 100;

export class MdPropNet extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    void view;

    // Leaves and sum.
    const a = num(20);
    const b = num(20);
    const c = num(20);
    const d = num(20);
    const total = num(80);

    // Build chain via two intermediate sums:
    //   ab = a + b; cd = c + d; total = ab + cd.
    const ab = num(0);
    const cd = num(0);

    const p = propagators();
    p.add(adder(a, b, ab));
    p.add(adder(c, d, cd));
    p.add(adder(ab, cd, total));

    const tracks = [
      { sig: a, label: "a", y: 80, color: "#5b8def" },
      { sig: b, label: "b", y: 130, color: "#5b8def" },
      { sig: c, label: "c", y: 180, color: "#5b8def" },
      { sig: d, label: "d", y: 230, color: "#5b8def" },
      { sig: total, label: "Σ", y: 310, color: "#f5a623" },
    ];

    const fixedV = (x: number, y: number) =>
      Vec.lens(
        () => ({ x, y }),
        () => {},
      );

    for (const t of tracks) {
      // Track line.
      s(line(fixedV(TRACK_X0, t.y), fixedV(TRACK_X1, t.y), { thin: true, opacity: 0.4 }));

      // Handle position derived from signal.
      const handlePos = Vec.lens(
        () => ({
          x: TRACK_X0 + (t.sig.value / VAL_MAX) * (TRACK_X1 - TRACK_X0),
          y: t.y,
        }),
        v => {
          const v01 = (v.x - TRACK_X0) / (TRACK_X1 - TRACK_X0);
          (t.sig as unknown as { value: number }).value = Math.max(
            0,
            Math.min(VAL_MAX, v01 * VAL_MAX),
          );
        },
      );
      const dot = s(circle(handlePos, 9, { fill: t.color }));
      dot.el.style.cursor = "ew-resize";
      drag(dot, handlePos, signal(false));

      // Numeric value label.
      s(
        label(fixedV(TRACK_X1 + 40, t.y + 4), () => t.sig.value.toFixed(1), {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        }),
      );
      // Letter label.
      s(
        label(fixedV(TRACK_X0 - 30, t.y + 4), t.label, {
          size: 16,
          align: Anchor.Center,
          opacity: 0.85,
        }),
      );
    }

    s(
      label(
        fixedV(280, 36),
        "drag any slider — three adders keep a + b + c + d = Σ",
        { size: 12, align: Anchor.Center, opacity: 0.7 },
      ),
      label(
        fixedV(280, 360),
        "5 Num cells • 3 adder() propagators • multi-direction in 1 pass",
        { size: 10, align: Anchor.Center, opacity: 0.55 },
      ),
    );
  }
}
