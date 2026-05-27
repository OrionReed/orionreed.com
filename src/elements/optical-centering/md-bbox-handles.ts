// md-bbox-handles.ts — resize a cluster by dragging its bounding box.
//
// Five draggable points, one closed-form `bboxLens` over them, two
// derived corner handles. Drag any point to recompute the bounds;
// drag the bounds to translate or resize the whole cluster.

import { bboxLens, derive, Diagram, handle, label, Mount, rect, Vec, vec } from "../../minim";

const PT = "#5b8def";
const CTR = "#f5a623";
const COR = "#e25c5c";

export class MdBboxHandles extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Five draggable points.
    const pts = [
      vec(cx - 140, cy - 60),
      vec(cx + 130, cy - 80),
      vec(cx + 100, cy + 70),
      vec(cx - 90, cy + 90),
      vec(cx + 20, cy - 30),
    ];

    // Bounding box of those points: {center: Writable<Vec>, size: Writable<Vec>}.
    const { center, size } = bboxLens(pts);

    // Bottom-right corner: a derived Vec lens. Writes back to size,
    // keeping center put — drag-to-resize from the corner.
    const corner = Vec.lens(
      [center, size] as const,
      ([c, sz]) => ({ x: c.x + sz.x / 2, y: c.y + sz.y / 2 }),
      (t, [c]) => [undefined, { x: 2 * (t.x - c.x), y: 2 * (t.y - c.y) }] as never,
    );

    s(
      // Bounds visualization (rect at center +/- size/2).
      rect(
        center,
        derive(() => size.value.x),
        derive(() => size.value.y),
        {
          thin: true,
          stroke: "#9b9b9b",
          opacity: 0.6,
        },
      ),
      // Five point handles.
      ...pts.map(p => handle(p, { fill: PT, r: 7 })),
      // Center handle (drags whole cluster).
      handle(center, { fill: CTR, r: 9 }),
      // Corner handle (drags size).
      handle(corner, { fill: COR, r: 7 }),
      label(
        view.top.down(20),
        "drag any blue point • drag orange to translate • drag red corner to resize",
      ),
      label(
        view.bottom.up(16),
        "bboxLens(points) → {center, size} · closed-form, exact cross-channel invariance",
        { size: 10 },
      ),
    );
  }
}
