// Bidirectional-lens showcase. A small "F" on the left of a draggable
// mirror; the F on the right is the reflection — every vertex is a lens
// of the original via the mirror. Reflection is its own inverse, so the
// same formula gives reads AND writes, and `handle(reflectedPoint)`
// works without any special-casing.
//
// What you can drag:
//   – any vertex of either F (4 + 4)
//   – either endpoint of the mirror (2)
//
// What happens for free:
//   – flipping one F mirrors the other in real time
//   – moving the mirror sweeps the reflection across space
//   – the dashed "centroid line" stays perpendicular to the mirror, a
//     classical geometric truth that falls out of the algebra
//
// Doing this in a non-reactive system means one event handler per
// vertex, a manual constraint propagator, and re-derivation of every
// dependent on every change. Here it's about ten lines of bookkeeping
// over one tiny `reflect` formula.

import {
  Anchor,
  Diagram,
  Mount,
  handle,
  label,
  lensPoint,
  line,
  meanVec,
  pt,
  type Point,
  type V,
} from "../../minim";

/** Reflect point `p` across the line through `a` and `b`. Degenerate
 *  line (a == b) returns `p` unchanged. */
function reflect(p: V, a: V, b: V): V {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return p;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const fx = a.x + t * dx;
  const fy = a.y + t * dy;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
}

export class MdMirror extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(720, 360);

    // Mirror endpoints — two free Points. Everything reflects through
    // the line they define, so dragging either re-aligns the world.
    const mA = pt(360, 30);
    const mB = pt(360, 330);

    // The reflection lens. `read` reflects the source across the
    // current mirror; `write` reflects back — the same formula, since
    // reflection is an involution (`R∘R = id`). One closure → both
    // directions of the handle for free.
    const mirrorOf = (src: Point): Point =>
      lensPoint(
        () => reflect(src.value, mA.value, mB.value),
        (target) => {
          src.value = reflect(target, mA.value, mB.value);
        },
      );

    // ── Original F: four free vertices, three lines ──────────────────
    const stemTop = pt(200, 90);
    const stemBot = pt(200, 270);
    const topRight = pt(280, 90);
    const midRight = pt(260, 180);
    const F = "#5b8def";

    // Middle bar attaches to the stem's midpoint — derived, so the bar
    // rides up and down when the stem stretches.
    const stemMid = stemTop.lerp(stemBot, 0.5);

    s(
      line(stemTop, stemBot, { stroke: F, strokeWidth: 4 }),
      line(stemTop, topRight, { stroke: F, strokeWidth: 4 }),
      line(stemMid, midRight, { stroke: F, strokeWidth: 4 }),
    );

    // ── Reflected F: lensed vertices, same topology ──────────────────
    const stemTopR = mirrorOf(stemTop);
    const stemBotR = mirrorOf(stemBot);
    const topRightR = mirrorOf(topRight);
    const midRightR = mirrorOf(midRight);
    const FR = "#e25c5c";

    const stemMidR = stemTopR.lerp(stemBotR, 0.5);

    s(
      line(stemTopR, stemBotR, { stroke: FR, strokeWidth: 4 }),
      line(stemTopR, topRightR, { stroke: FR, strokeWidth: 4 }),
      line(stemMidR, midRightR, { stroke: FR, strokeWidth: 4 }),
    );

    // ── Mirror line + centroid-link overlay ──────────────────────────
    s(line(mA, mB, { thin: true, dashed: true, opacity: 0.5 }));

    // ── Handles ──────────────────────────────────────────────────────
    // The atom `handle(point)` doesn't care whether the Point is free
    // or lensed — it just reads + writes. So the reflected F's vertices
    // are draggable too: grabbing one inverts the reflection and pulls
    // the original behind it.
    s(
      handle(stemTop),
      handle(stemBot),
      handle(topRight),
      handle(midRight),
      handle(stemTopR),
      handle(stemBotR),
      handle(topRightR),
      handle(midRightR),
      handle(mA),
      handle(mB),
    );

    // ── Labels ──────────────────────────────────────────────────────
    s(
      label(
        view.top.down(20),
        "drag any handle — original, reflected, or the mirror itself",
        { size: 12, align: Anchor.Center, opacity: 0.7 },
      ),
      label(
        view.bottom.up(16),
        "lensPoint(read = reflect,  write = reflect)  ·  one formula, both directions",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
