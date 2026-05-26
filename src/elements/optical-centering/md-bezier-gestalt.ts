// md-bezier-gestalt.ts — gestalt handles vs raw control points on a curve.
//
// Two equivalent ways to edit a cubic Bezier are present at once:
//
//   raw (dim grey): drag p0, p1, p2, p3 directly — the classic four
//     control-point UI; moving an interior control breaks the tangent.
//
//   gestalt (bright): drag start, end, startTangent, endTangent —
//     `bezierGestaltLens(p0..p3)` projects the same 8 scalars into four
//     handles that preserve curve-shape invariants:
//
//       * drag start (orange)  → p0 AND p1 translate together (tangent vector preserved)
//       * drag startTangent    → only p1 moves (start untouched)
//       * (same for end / endTangent)
//
// Watch the dim p1 marker when you drag start vs startTangent — the
// difference is the whole point.

import {
  bezierGestaltLens,
  computed,
  Diagram,
  handle,
  label,
  line,
  Mount,
  pathD,
  Vec,
  vec,
} from "../../minim";

export class MdBezierGestalt extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Raw control points (also directly draggable, for contrast).
    const p0 = vec(cx - 220, cy + 50);
    const p1 = vec(cx - 100, cy - 100);
    const p2 = vec(cx + 100, cy + 150);
    const p3 = vec(cx + 220, cy - 30);

    // Gestalt decomposition.
    const { start, end, startTangent, endTangent } = bezierGestaltLens(p0, p1, p2, p3);

    // Tangent handle CANVAS positions (= base + tangent vector).
    const startTanHandle = Vec.lens(
      [start, startTangent] as const,
      ([a, t]) => ({ x: a.x + t.x, y: a.y + t.y }),
      (target, [a]) => [undefined, { x: target.x - a.x, y: target.y - a.y }] as never,
    );
    const endTanHandle = Vec.lens(
      [end, endTangent] as const,
      ([a, t]) => ({ x: a.x + t.x, y: a.y + t.y }),
      (target, [a]) => [undefined, { x: target.x - a.x, y: target.y - a.y }] as never,
    );

    // Reactive cubic Bezier `d` string.
    const d = computed(() => {
      const a = p0.value;
      const b = p1.value;
      const c = p2.value;
      const e = p3.value;
      return `M ${a.x} ${a.y} C ${b.x} ${b.y} ${c.x} ${c.y} ${e.x} ${e.y}`;
    });

    s(
      // The curve itself.
      pathD(d, { stroke: "#5b8def", strokeWidth: 2.5 }),
      // Raw control polygon p0-p1-p2-p3 (dim, dashed).
      line(p0, p1, { thin: true, opacity: 0.25, dashed: true }),
      line(p1, p2, { thin: true, opacity: 0.25, dashed: true }),
      line(p2, p3, { thin: true, opacity: 0.25, dashed: true }),
      // Tangent guides from start/end to tangent handles (subtle).
      line(start, startTanHandle, { thin: true, opacity: 0.45 }),
      line(end, endTanHandle, { thin: true, opacity: 0.45 }),
      // Raw interior controls — directly draggable, dim.
      handle(p1, { fill: "#bbbbbb", r: 5 }),
      handle(p2, { fill: "#bbbbbb", r: 5 }),
      // Gestalt handles, bright. Drag these to see invariants:
      handle(start, { fill: "#f5a623", r: 9 }),
      handle(end, { fill: "#f5a623", r: 9 }),
      handle(startTanHandle, { fill: "#7ed321", r: 7 }),
      handle(endTanHandle, { fill: "#7ed321", r: 7 }),
      label(
        view.top.down(20),
        "drag orange (start/end) → p1/p2 follow · drag green (tangent) → only p1/p2 move",
      ),
      label(
        view.bottom.up(16),
        "grey dots are raw control points · orange/green are the bezierGestaltLens",
        { size: 10 },
      ),
    );
  }
}
