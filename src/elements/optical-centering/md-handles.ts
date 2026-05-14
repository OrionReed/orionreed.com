// Interactivity showcase. Two scenes share one viewport: a manipulable
// triangle on the left, a transform-handle rect on the right.
//
// Triangle:                         Rect:
//   3 vertices, drag each            move handle (center)
//   3 edges that track them          rotate handle (orbits center)
//   1 centroid handle (rigid move)   debug.box + debug.origin overlay
//   debug.distance on each edge
//
// Every handle is just a lens with a visible UI shadow: read its source,
// drag writes back through. No interaction layer, no special-casing —
// the same algebra animates and interacts.

import { Anchor, Diagram, Mount, circle, debug, handle, label, line, rect } from "../../minim";

export class MdHandles extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(680, 360);

    // ── Left: manipulable triangle ─────────────────────────────────
    // Initial vertex positions form a balanced triangle around (165, 180).
    const a = s(circle(view.left.right(110).up(50), 18, { fill: "#5b8def" }));
    const b = s(circle(view.left.right(220).up(50), 18, { fill: "#f5a623" }));
    const c = s(circle(view.left.right(165).down(60), 18, { fill: "#e25c5c" }));

    // Live distance labels on each edge — debug.distance is a derived
    // shape that produces a faint dashed line + a centered length label.
    s(debug.distance(a, b), debug.distance(b, c), debug.distance(c, a));

    // Per-vertex move handles render as small blue dots on top of each
    // colored disk; dragging writes to `vertex.center` (lens to translate),
    // which moves the disk and ripples through every dependent.
    //
    // The centroid handle is a fourth dot at the mean of the three
    // visible centers. Dragging it distributes the delta to all three
    // shapes — rigid group translation falls out of the lens algebra
    // (same trick as `centroid(...)` in scene/aggregates.ts).
    s(handle.move(a), handle.move(b), handle.move(c), handle.centroid(a, b, c));

    // ── Right: transform-handle rect ───────────────────────────────
    const r = s(rect(0, 0, 110, 76, { thin: true, corner: 4 }));
    r.center.set(view.right.left(120));

    // Debug overlay — dashed parent-frame box (axis-aligned, tracks
    // the rotated rect) + crosshair at the rotate/scale pivot.
    s(debug.box(r), debug.origin(r));

    // Move handle on the rect's center; rotate knob orbits the center
    // at a fixed radius. Drag the orbit handle to spin the rect.
    s(handle.move(r), handle.rotate(r, 70));

    // ── Labels ──────────────────────────────────────────────────────
    s(
      label(
        view.top.down(20),
        "drag any blue handle — vertices, centroid, rotate",
        {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        },
      ),
      label(
        view.bottom.up(16),
        "handle(point) is the atom · move / centroid / rotate are 1-line sugar",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
