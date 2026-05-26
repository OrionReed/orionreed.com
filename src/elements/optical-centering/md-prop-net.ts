// md-prop-net.ts — a Sussman-style propagator network.
//
//                         total
//                          │
//                       ┌──┴──┐
//                       │ +   │       (a + b + c + d = total)
//                       └─┬─┬─┘
//                       a b c d
//
// Four leaves and a sum. Pull any one slider; the others
// rebalance so the sum stays exact. Pull the "total" slider; all
// four leaves redistribute the slack (split equally because the
// network is symmetric).
//
// No solver, no convergence loop — straight propagator
// arithmetic, instant.

import { add, propagate } from "@minim/propagators";
import { Diagram, handle, label, line, Mount, num, vec, Vec } from "../../minim";

const X0 = 100;
const X1 = 460;
const VMAX = 100;
const TRACK = { thin: true, opacity: 0.4 };
const LEAF = { fill: "#5b8def", r: 9 };
const TOTAL = { fill: "#f5a623", r: 9 };

export class MdPropNet extends Diagram {
  protected scene(s: Mount): void {
    this.view(560, 380);

    const a = num(20);
    const b = num(20);
    const c = num(20);
    const d = num(20);
    const total = num(80);
    const ab = num(0);
    const cd = num(0);

    propagate(add(a, b, ab), add(c, d, cd), add(ab, cd, total));

    const tracks = [
      { sig: a, name: "a", y: 80, opts: LEAF },
      { sig: b, name: "b", y: 130, opts: LEAF },
      { sig: c, name: "c", y: 180, opts: LEAF },
      { sig: d, name: "d", y: 230, opts: LEAF },
      { sig: total, name: "Σ", y: 310, opts: TOTAL },
    ];

    for (const t of tracks) {
      // Slider position derived from value (1D handle along x).
      const knob = Vec.lens(
        () => ({ x: X0 + (t.sig.value / VMAX) * (X1 - X0), y: t.y }),
        v => {
          const v01 = (v.x - X0) / (X1 - X0);
          (t.sig as { value: number }).value = Math.max(0, Math.min(VMAX, v01 * VMAX));
        },
      );
      s(
        line(vec(X0, t.y), vec(X1, t.y), TRACK),
        handle(knob, { ...t.opts, cursor: "ew-resize" }),
        label(vec(X0 - 30, t.y + 4), t.name, { size: 16 }),
        label(vec(X1 + 40, t.y + 4), () => t.sig.value.toFixed(1)),
      );
    }

    s(
      label(vec(280, 36), "drag any slider — three add() propagators keep a + b + c + d = Σ"),
      label(vec(280, 360), "5 Num cells • 3 add() propagators • multi-direction in 1 pass", {
        size: 10,
      }),
    );
  }
}
