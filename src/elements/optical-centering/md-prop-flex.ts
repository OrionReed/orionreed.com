// md-prop-flex.ts — terse layout via propagators.
//
// Six items distributed in a flex row inside a draggable container.
// Min-width clamps, gap is a draggable signal. Every box's geometry
// is a Box value-type; the layout is a single `hstack` propagator.
//
//   propagate(hstack(c, items.map(b => ({ box: b, min: 30 })), { gap }));
//
// Drag the container's right edge to resize. Drag the gap handle
// (above) to widen / narrow inter-item spacing. Items shrink to
// their min, then overflow.

import { hstack, propagate } from "@minim/propagators";
import {
  box,
  Diagram,
  handle,
  label,
  line,
  type Mount,
  Num,
  num,
  rect,
  Vec,
  vec,
} from "../../minim";

const ITEM_COLORS = ["#5b8def", "#e25c5c", "#f5a623", "#86b966", "#9c6bce", "#5fb1c6"];

export class MdPropFlex extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 360);
    const { x: cx, y: cy } = view.center.value;

    const c = box(cx - 250, cy - 30, 500, 80);
    const gap = num(8);
    const items = Array.from({ length: 6 }, () => box(0, 0, 60, 80));

    propagate(
      hstack(
        c,
        items.map(it => ({ box: it, min: 30, max: 200 })),
        { gap, align: "stretch" },
      ),
    );

    // Right-edge handle for container width.
    const rightEdge = Vec.lens(
      () => ({ x: c.x.value + c.w.value, y: c.y.value + c.h.value / 2 }),
      v => {
        const newW = v.x - c.x.value;
        if (newW > 60) (c.w as { value: number }).value = newW;
      },
    );

    // Gap handle along a horizontal track above the container. Pixel ↔
    // value via a clamped affine chain; y locked at the track row.
    const trackY = c.y.value - 36;
    const [tx0, tx1, gMin, gMax] = [cx - 100, cx + 100, 0, 40];
    const k = (tx1 - tx0) / (gMax - gMin);
    const gapKnob = vec(gap.clamp(gMin, gMax).affine(k, tx0 - gMin * k), Num.pin(trackY));

    s(
      rect(c.x, c.y, c.w, c.h, { stroke: "#666", fill: "#00000010", thin: true }),
      ...items.map((it, i) =>
        rect(it.x, it.y, it.w, it.h, { fill: ITEM_COLORS[i]!, opacity: 0.45, corner: 4 }),
      ),
      handle(rightEdge, { r: 6, fill: "#999", cursor: "ew-resize" }),
      line(vec(tx0, trackY), vec(tx1, trackY), { thin: true, opacity: 0.4 }),
      handle(gapKnob, { r: 6, fill: "#444", cursor: "ew-resize" }),
      label(view.top.down(20), "drag the gap slider above • drag the right edge of the container"),
      label(
        view.bottom.up(16),
        "one hstack(...) propagator • items clamp at min-width 30 • bounds invisible to caller",
        { size: 10 },
      ),
    );
  }
}
