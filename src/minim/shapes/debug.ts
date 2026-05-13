// debug.* — read-only diagnostic shapes that visualize layout state.
//
// Every debug shape is `aside: true` (so it's excluded from autofit) and
// uses a shared visual idiom: dashed magenta strokes, low opacity, small
// markers. Drop `s(debug.box(thing))` while developing, delete when done.
//
// All debug shapes report in PARENT frame: for a `Shape`, the Box is
// transformed through the shape's transform first (so you see the visual
// footprint, not the pre-transform local one); for non-Shape Boxes (a
// view, a split, a grid cell), the Box is already parent-frame.
//
// The `--minim-debug` CSS var lets authors theme; the fallback is
// magenta so debug shapes always read as "scaffolding".

import {
  Vec,
  Shape,
  isPoint,
  type AnyShape,
  type Boxlike,
  type Pointlike,
} from "../scene";
import { Box } from "../values/box";
import { transformBox, transformPoint } from "../values/matrix";
import { circle } from "./circle";
import { line } from "./line";
import { label } from "./label";
import { rect } from "./rect";
import { group } from "./group";
import type { Path } from "./path";

const COLOR = "var(--minim-debug, #c026d3)";

const baseOpts = { aside: true, opacity: 0.6 };
const outlineOpts = {
  stroke: COLOR,
  fill: "none",
  thin: true,
  dashed: true,
  ...baseOpts,
};

/** Parent-frame Box for any Boxlike. Shapes get their transform applied
 *  (so the Box reflects the visual footprint); non-Shape Boxes pass
 *  through. */
function parentBox(b: Boxlike): Boxlike {
  if (b instanceof Shape) {
    return Box.derived(() => transformBox(b.localFrame.value, b.box.value));
  }
  return b;
}

/** Dashed rect on a Box's parent-frame Box. */
const boxOutline = (b: Boxlike) => rect(parentBox(b), outlineOpts);

/** Small filled dot at a point or a Box's center. */
const dot = (p: Pointlike | Boxlike, r = 2.5) =>
  circle(isPoint(p) ? p : p.center, r, {
    fill: COLOR,
    stroke: "none",
    ...baseOpts,
  });

/** Crosshair at a Shape's rotate/scale pivot, in parent frame. */
const origin = (s: Shape, size = 8) => {
  const pivot = Vec.derived(() =>
    transformPoint(s.localFrame.value, s.origin.value),
  );
  const half = size / 2;
  const g = group({ aside: true, opacity: 0.75 });
  g.add(
    line(pivot.left(half), pivot.right(half), {
      stroke: COLOR,
      thin: true,
    }),
    line(pivot.up(half), pivot.down(half), {
      stroke: COLOR,
      thin: true,
    }),
    circle(pivot, 1.5, { fill: COLOR, stroke: "none" }),
  );
  return g;
};

/** Dots at the 9 standard anchor positions: corners, edge midpoints,
 *  center. */
const anchors = (b: Boxlike, r = 2.5) => {
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
const connect = (a: AnyShape | Pointlike, b: AnyShape | Pointlike) => {
  const aP: Pointlike = a instanceof Shape ? a.center : a;
  const bP: Pointlike = b instanceof Shape ? b.center : b;
  return line(aP, bP, {
    stroke: COLOR,
    thin: true,
    dashed: true,
    ...baseOpts,
  });
};

/** `connect(a, b)` + a live distance label at the midpoint. */
const distance = (a: AnyShape | Pointlike, b: AnyShape | Pointlike) => {
  const aP: Pointlike = a instanceof Shape ? a.center : a;
  const bP: Pointlike = b instanceof Shape ? b.center : b;
  const mid = aP.lerp(bP, 0.5);
  const d = aP.distance(bP);
  const g = group({ aside: true });
  g.add(
    connect(aP, bP),
    label(mid.up(6), d.derive((v) => v.toFixed(0)), {
      size: 10,
      opacity: 0.85,
    }),
  );
  return g;
};

/** Markers + tiny tangent ticks at evenly-spaced t along a Path. */
const path = (p: Path, ticks = 5) => {
  const g = group({ aside: true, opacity: 0.75 });
  for (let i = 0; i < ticks; i++) {
    const t = ticks === 1 ? 0 : i / (ticks - 1);
    const head = p.pointAt(t);
    const tan = p.tangentAt(t);
    const tip = Vec.derived(() => ({
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
