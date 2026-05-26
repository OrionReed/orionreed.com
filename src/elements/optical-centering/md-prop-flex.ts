// md-prop-flex.ts — terse layout via propagators.
//
// Six items distributed in a flex row inside a draggable container.
// Min-width clamps, gap is a draggable signal. Every box's geometry
// is a Box value-type; the layout is a single `hstack` propagator.
//
//   p.add(hstack(c, items, { gap, minSize: 30 }));
//
// Drag the container's right edge to resize. Drag the gap handle
// (above) to widen / narrow inter-item spacing. Items shrink to
// their min, then overflow.

import { hstack, propagators } from "@minim/propagators";
import {
  Anchor,
  box,
  circle,
  Diagram,
  drag,
  handle,
  label,
  line,
  Mount,
  num,
  rect,
  signal,
  Vec,
} from "../../minim";

const ITEM_COLORS = ["#5b8def", "#e25c5c", "#f5a623", "#86b966", "#9c6bce", "#5fb1c6"];

export class MdPropFlex extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Container box — draggable on the right edge.
    const containerX = num(cx - 250);
    const containerY = num(cy - 30);
    const containerW = num(500);
    const containerH = num(80);
    const c = box(containerX, containerY, containerW, containerH);
    const gap = num(8);

    // Six items, each starting at width 60 (will get clamped/grown).
    const N = 6;
    const items = Array.from({ length: N }, () => box(0, 0, 60, 80));

    // Single propagator that does the whole layout.
    const p = propagators();
    p.add(hstack(c, items, { gap, minSize: 30, maxSize: 200, align: "stretch" }));

    // Render container outline.
    s(
      rect(containerX, containerY, containerW, containerH, {
        stroke: "#666",
        fill: "#00000010",
        thin: true,
      }),
    );

    // Render each item rect using its Box's reactive fields.
    items.forEach((it, i) => {
      s(rect(it.x, it.y, it.w, it.h, { fill: ITEM_COLORS[i]!, opacity: 0.45, corner: 4 }));
    });

    // Right-edge handle: drag to resize container width.
    const rightHandle = Vec.lens(
      () => ({
        x: containerX.value + containerW.value,
        y: containerY.value + containerH.value / 2,
      }),
      v => {
        const newW = v.x - containerX.value;
        if (newW > 60) (containerW as { value: number }).value = newW;
      },
    );
    s(handle(rightHandle, { r: 6, fill: "#999", cursor: "ew-resize" }));

    // Gap handle: a draggable knob along a track above the container.
    const trackY = containerY.value - 36;
    const trackX0 = cx - 100;
    const trackX1 = cx + 100;
    const gapMin = 0;
    const gapMax = 40;

    const fixedV = (x: number, y: number) =>
      Vec.lens(
        () => ({ x, y }),
        () => {},
      );
    s(line(fixedV(trackX0, trackY), fixedV(trackX1, trackY), { thin: true, opacity: 0.4 }));
    const gapPos = Vec.lens(
      () => ({
        x: trackX0 + ((gap.value - gapMin) / (gapMax - gapMin)) * (trackX1 - trackX0),
        y: trackY,
      }),
      (v: { x: number; y: number }) => {
        const v01 = (v.x - trackX0) / (trackX1 - trackX0);
        const next = gapMin + Math.max(0, Math.min(1, v01)) * (gapMax - gapMin);
        (gap as { value: number }).value = next;
      },
    );
    const knob = s(circle(gapPos, 6, { fill: "#444" }));
    knob.el.style.cursor = "ew-resize";
    drag(knob, gapPos, signal(false));

    s(
      label(view.top.down(20), "drag the gap slider above • drag the right edge of the container", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "one hstack(...) propagator • items clamp at min-width 30 • bounds invisible to caller",
        { size: 10, align: Anchor.Center, opacity: 0.55 },
      ),
    );
  }
}
