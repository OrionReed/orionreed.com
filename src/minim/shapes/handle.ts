// handle.* — writable derived shapes (draggable circles wired to a Vec).

import { Mix, mix, polar as polarLens, Signal, signal, Vec, type Writable } from "@minim/signals";
import { Circle, type CircleOpts } from "./circle";
import { drag } from "./interaction";
import type { Path } from "./path";
import { type AnyShape, type Has } from "./shape";

const COLOR = "var(--minim-handle, #2563eb)";

export interface HandleOpts {
  /** Handle radius (px). Default 6. */
  r?: number;
  /** Fill color. Default `--minim-handle`. */
  fill?: string;
  /** CSS cursor on hover. Default `grab`. */
  cursor?: string;
}

/** Draggable circular handle with observable drag state.
 *
 *  `Handle` IS a `Circle` — same DOM, same Shape semantics — plus a
 *  `dragging: Signal<boolean>` that flips true on pointerdown and
 *  false on pointerup/cancel. Use it in `at(...)`, `when(...)`, etc.
 *  to coordinate animations with user interaction:
 *
 *      const h = s(handle(target));
 *      anim.start(spring(target, REST, { rate: () => h.dragging.value ? 0 : 1 }));
 */
export class Handle extends Circle {
  readonly dragging: Signal<boolean>;
  constructor(target: Writable<Vec>, opts: HandleOpts = {}) {
    const circleOpts: CircleOpts = {
      fill: opts.fill ?? COLOR,
      // Background-colored halo so the handle pops on either theme.
      stroke: "var(--bg-color, white)",
      strokeWidth: 2,
      aside: true,
    };
    super(target, opts.r ?? 6, circleOpts);
    this.el.style.cursor = opts.cursor ?? "grab";
    this.dragging = signal(false);
    this.disposers.push(drag(this, target, this.dragging));
  }
}

function handleFn(target: Writable<Vec>, opts: HandleOpts = {}): Handle {
  return new Handle(target, opts);
}

/** Drag handle at the shape's center — drags translate the shape. */
const move = (shape: AnyShape & Has<"translate">, opts?: HandleOpts): Handle =>
  handleFn(shape.center, opts);

/** Drag handle at a specific anchor `(u, v)` of the shape — drag
 *  translates the shape so that anchor lands at the pointer. */
const anchor = (
  shape: AnyShape & Has<"translate">,
  u: number,
  v: number,
  opts?: HandleOpts,
): Handle => handleFn(shape.at(u, v), opts);

/** Drag handle at the centroid of N shapes' visual centers — drags
 *  translate every shape by the same delta, so the group moves rigidly
 *  while preserving the original triangle/quad/whatever shape. Reads
 *  give the actual centroid of the visible positions (not of translate
 *  deltas — see `centroid` in `shape.ts` for that variant). */
const centroidHandle = (...shapes: (AnyShape & Has<"translate">)[]): Handle =>
  handleFn(
    mix(
      Vec,
      shapes.map(s => s.center),
      Mix.mean,
      Mix.deltaEven,
    ),
  );

/** Drag handle at the midpoint of two writable Points — drags both
 *  along with it. */
const midpoint = (a: Writable<Vec>, b: Writable<Vec>, opts?: HandleOpts): Handle =>
  handleFn(mix(Vec, [a, b], Mix.mean, Mix.deltaEven), opts);

/** Rotation knob orbiting the shape's center at `radius`. The knob
 *  position is `center + (r cos θ, r sin θ)` for `θ = shape.rotate`;
 *  drag the knob to write θ. */
const rotate = (shape: AnyShape & Has<"rotate">, radius = 40, opts?: HandleOpts): Handle => {
  // Built directly on `polar` with the `circular` policy — c and r
  // are fixed; writes only update θ.
  return handleFn(polarLens(shape.center, radius, shape.rotate, "circular"), {
    cursor: "grab",
    ...opts,
  });
};

/** Uniform-scale knob — sits along +x from the shape's center at
 *  `radius * scale.x`. Drag x-distance writes both scale axes. */
const scaleHandle = (shape: AnyShape & Has<"scale">, radius = 40, opts?: HandleOpts): Handle => {
  const pos = Vec.lens(
    () => {
      const c = shape.center.value;
      const s = shape.scale.value;
      return { x: c.x + radius * s.x, y: c.y };
    },
    target => {
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
const tOnPath = (p: Path, t: Signal<number>, opts?: HandleOpts & { samples?: number }): Handle => {
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
  const pos = Vec.lens(
    () => p.pointAt(t.value).value,
    target => {
      (t as unknown as { value: number }).value = project(target);
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
