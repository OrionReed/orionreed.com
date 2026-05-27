// debug.* — read-only diagnostic shapes that visualize layout state.

import { Box, derive, transformBox, transformPoint, Vec } from "@minim/signals";
import { circle } from "./circle";
import { group } from "./group";
import { label } from "./label";
import { line } from "./line";
import type { Path } from "./path";
import { rect } from "./rect";
import { type AnyShape, Shape } from "./shape";

const COLOR = "var(--minim-debug, #c026d3)";

const baseOpts = { aside: true, opacity: 0.6 };
const outlineOpts = {
  stroke: COLOR,
  fill: "none",
  thin: true,
  dashed: true,
  ...baseOpts,
};

/** Parent-frame Box. Shapes have their transform applied (so the
 *  Box reflects the visual footprint); raw Boxes pass through. */
function parentBox(b: Shape | Box): Box {
  if (b instanceof Shape) {
    return Box.derive(() => transformBox(b.localFrame.value, b.box.value));
  }
  return b;
}

/** Dashed rect over a Shape's parent-frame box (or a raw Box). */
const boxOutline = (b: Shape | Box) => rect(parentBox(b), outlineOpts);

/** Small filled dot at a point or a Box's / Shape's center. */
const dot = (p: Vec | Shape | Box, r = 2.5) => {
  const at = p instanceof Vec ? p : p instanceof Shape ? p.center : p.center;
  return circle(at, r, { fill: COLOR, stroke: "none", ...baseOpts });
};

/** Crosshair at a Shape's rotate/scale pivot, in parent frame. */
const origin = (s: Shape, size = 8) => {
  const pivot = Vec.derive(() => transformPoint(s.localFrame.value, s.origin.value));
  const half = size / 2;
  return group(
    { aside: true, opacity: 0.75 },
    line(pivot.left(half), pivot.right(half), { stroke: COLOR, thin: true }),
    line(pivot.up(half), pivot.down(half), { stroke: COLOR, thin: true }),
    circle(pivot, 1.5, { fill: COLOR, stroke: "none" }),
  );
};

/** Dots at the 9 standard anchor positions: corners, edge midpoints,
 *  center. */
const anchors = (b: Shape | Box, r = 2.5) => {
  const g = group({ aside: true, opacity: 0.7 });
  for (const u of [0, 0.5, 1]) {
    for (const v of [0, 0.5, 1]) {
      g.add(
        circle(b.at(u, v), r, {
          fill: COLOR,
          stroke: "none",
        }),
      );
    }
  }
  return g;
};

/** Faint dashed line between two shapes' (or points') centers. */
const connect = (a: AnyShape | Vec, b: AnyShape | Vec) => {
  const aP: Vec = a instanceof Shape ? a.center : a;
  const bP: Vec = b instanceof Shape ? b.center : b;
  return line(aP, bP, {
    stroke: COLOR,
    thin: true,
    dashed: true,
    ...baseOpts,
  });
};

/** `connect(a, b)` + a live distance label at the midpoint. */
const distance = (a: AnyShape | Vec, b: AnyShape | Vec) => {
  const aP: Vec = a instanceof Shape ? a.center : a;
  const bP: Vec = b instanceof Shape ? b.center : b;
  const mid = aP.lerp(bP, 0.5);
  const d = aP.distance(bP);
  return group(
    { aside: true },
    connect(aP, bP),
    label(
      mid.up(6),
      derive(() => d.value.toFixed(0)),
      { size: 10, opacity: 0.85 },
    ),
  );
};

/** Markers + tiny tangent ticks at evenly-spaced t along a Path. */
const path = (p: Path, ticks = 5) => {
  const g = group({ aside: true, opacity: 0.75 });
  for (let i = 0; i < ticks; i++) {
    const t = ticks === 1 ? 0 : i / (ticks - 1);
    const head = p.pointAt(t);
    const tan = p.tangentAt(t);
    const tip = Vec.derive(() => ({
      x: head.value.x + tan.value.x * 6,
      y: head.value.y + tan.value.y * 6,
    }));
    g.add(
      circle(head, 2.5, { fill: COLOR, stroke: "none" }),
      line(head, tip, { stroke: COLOR, thin: true }),
    );
  }
  return g;
};

/** debug.* — diagnostic overlays. All are `aside: true` so they don't
 *  infect autofit. Drop in during development, remove when done. */
export const debug = {
  box: boxOutline,
  dot,
  origin,
  anchors,
  connect,
  distance,
  path,
};
