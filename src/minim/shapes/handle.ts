// handle.* — writable derived shapes: small draggable circles wired to
// a Point (or Signal-pair). Reads come from the source; writes go back.
//
// The atom is `handle(point)`. Every other helper is sugar that picks
// the writable source — `handle.move(shape)` wires to `shape.center`,
// `handle.centroid(...shapes)` wires to the centroid lens, etc. Same
// algebra as `centroid(...)`: a lens with a visible UI shadow.
//
// All handles are `aside: true` (no autofit contribution) and themable
// via the `--minim-handle` CSS var.

import { type Signal } from "../core";
import {
  Shape,
  lensPoint,
  meanVec,
  type AnyShape,
  type Point,
  type Writable,
} from "../scene";
import { draggable } from "../scene/interaction";
import { circle } from "./circle";
import type { Path } from "./path";

const COLOR = "var(--minim-handle, #2563eb)";

export interface HandleOpts {
  /** Handle radius (px). Default 6. */
  r?: number;
  /** Fill color. Default `--minim-handle`. */
  fill?: string;
  /** CSS cursor on hover. Default `grab`. */
  cursor?: string;
}

/** Atom: a small draggable circle wired to a writable Point. Every
 *  named helper below is sugar — picks the writable source, hands it
 *  to this. */
function handleFn(target: Point, opts: HandleOpts = {}): Shape {
  const h = circle(target, opts.r ?? 6, {
    fill: opts.fill ?? COLOR,
    // Background-colored halo so the handle pops on either theme.
    stroke: "var(--bg-color, white)",
    strokeWidth: 2,
    aside: true,
  });
  h.el.style.cursor = opts.cursor ?? "grab";

  // Capture the grab offset on pointerdown so the handle stays under
  // the cursor at the grab point — without this, the target snaps so
  // its origin is exactly at the pointer, which feels jumpy for
  // anything other than tiny handles.
  let dx = 0;
  let dy = 0;
  h.on("pointerdown", (e) => {
    const local = h.toLocal(e as PointerEvent);
    const v = target.value;
    dx = local.x - v.x;
    dy = local.y - v.y;
  });
  draggable(h, (local) => {
    target.value = { x: local.x - dx, y: local.y - dy };
  });

  return h;
}

/** Drag handle at the shape's center — drags translate the shape. */
const move = (
  shape: AnyShape & Writable<"translate">,
  opts?: HandleOpts,
): Shape => handleFn(shape.center, opts);

/** Drag handle at a specific anchor `(u, v)` of the shape — drag
 *  translates the shape so that anchor lands at the pointer. */
const anchor = (
  shape: AnyShape & Writable<"translate">,
  u: number,
  v: number,
  opts?: HandleOpts,
): Shape => handleFn(shape.at(u, v), opts);

/** Drag handle at the centroid of N shapes' visual centers — drags
 *  translate every shape by the same delta, so the group moves rigidly
 *  while preserving the original triangle/quad/whatever shape. Reads
 *  give the actual centroid of the visible positions (not the centroid
 *  of translate deltas — see `scene/aggregates.ts` for that variant). */
const centroidHandle = (
  ...shapes: (AnyShape & Writable<"translate">)[]
): Shape => handleFn(meanVec(...shapes.map((s) => s.center)) as Point);

/** Drag handle at the midpoint of two writable Points — drags both
 *  along with it. */
const midpoint = (a: Point, b: Point, opts?: HandleOpts): Shape =>
  handleFn(meanVec(a, b), opts);

/** Rotation knob orbiting the shape's center at `radius`. The knob
 *  position is `center + (r cos θ, r sin θ)` for `θ = shape.rotate`;
 *  drag the knob to write θ. */
const rotate = (
  shape: AnyShape & Writable<"rotate">,
  radius = 40,
  opts?: HandleOpts,
): Shape => {
  const pos = lensPoint(
    () => {
      const c = shape.center.value;
      const a = shape.rotate.value;
      return { x: c.x + radius * Math.cos(a), y: c.y + radius * Math.sin(a) };
    },
    (target) => {
      const c = shape.center.value;
      shape.rotate.value = Math.atan2(target.y - c.y, target.x - c.x);
    },
  );
  return handleFn(pos, { cursor: "grab", ...opts });
};

/** Uniform-scale knob — sits along +x from the shape's center at
 *  `radius * scale.x`. Drag x-distance writes both scale axes. */
const scaleHandle = (
  shape: AnyShape & Writable<"scale">,
  radius = 40,
  opts?: HandleOpts,
): Shape => {
  const pos = lensPoint(
    () => {
      const c = shape.center.value;
      const s = shape.scale.value;
      return { x: c.x + radius * s.x, y: c.y };
    },
    (target) => {
      const c = shape.center.value;
      const k = Math.max(0.05, Math.abs(target.x - c.x) / radius);
      shape.scale.value = { x: k, y: k };
    },
  );
  return handleFn(pos, { cursor: "ew-resize", ...opts });
};

/** Handle constrained to slide along a Path. Drag the handle and the
 *  pointer is projected onto the path; `t` is set to the nearest
 *  parameter. Re-projects every drag step, so works on animated paths. */
const tOnPath = (
  p: Path,
  t: Signal<number>,
  opts?: HandleOpts & { samples?: number },
): Shape => {
  const N = opts?.samples ?? 64;
  const project = (target: { x: number; y: number }) => {
    let bestT = 0;
    let bestD = Infinity;
    for (let i = 0; i <= N; i++) {
      const tt = i / N;
      const pp = p.pointAt(tt).value;
      const d = (pp.x - target.x) ** 2 + (pp.y - target.y) ** 2;
      if (d < bestD) {
        bestD = d;
        bestT = tt;
      }
    }
    return bestT;
  };
  const pos = lensPoint(
    () => p.pointAt(t.value).value,
    (target) => {
      t.value = project(target);
    },
  );
  return handleFn(pos, opts);
};

/** `handle(point)` is the atom; `handle.move(shape)`, `handle.centroid
 *  (...shapes)`, etc. are sugar. All return a Shape mountable via `s(...)`. */
export const handle = Object.assign(handleFn, {
  move,
  anchor,
  centroid: centroidHandle,
  midpoint,
  rotate,
  scale: scaleHandle,
  tOnPath,
});
