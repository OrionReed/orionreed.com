// handle.* — writable derived shapes (draggable circles wired to a Vec).

import {
  centroidLens,
  midpointLens,
  polar as polarLens,
  type Signal,
  signal,
  type Val,
  Vec,
  type Writable,
} from "@minim/signals";
import { Circle, type CircleOpts } from "./circle";
import { drag } from "./interaction";
import type { Path } from "./path";
import type { AnyShape, Has } from "./shape";

const COLOR = "var(--minim-handle, #2563eb)";

export interface HandleOpts {
  /** Handle radius (px). Default 6. */
  r?: number;
  /** Fill color. Default `--minim-handle`. Accepts reactive values. */
  fill?: Val<string>;
  /** CSS cursor on hover. Default `grab`. */
  cursor?: string;
}

/** Draggable circular handle. A `Circle` plus a `dragging` signal (true
 *  between pointerdown and pointerup/cancel) for coordinating animations. */
export class Handle extends Circle {
  readonly dragging: Writable<Signal<boolean>>;
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

/** Drag handle at the centroid of N shapes' visual centers; drags translate
 *  all shapes rigidly. Reads the centroid of visible positions (cf. `centroid`
 *  in `shape.ts`, which works on translate deltas). */
const centroidHandle = (...shapes: (AnyShape & Has<"translate">)[]): Handle =>
  handleFn(centroidLens(shapes.map(s => s.center)));

/** Drag handle at the midpoint of two writable Points — drags both
 *  along with it. */
const midpoint = (a: Writable<Vec>, b: Writable<Vec>, opts?: HandleOpts): Handle =>
  handleFn(midpointLens(a, b), opts);

/** Rotation knob orbiting the shape's center at `radius`; drag to write
 *  `shape.rotate`. */
const rotate = (shape: AnyShape & Has<"rotate">, radius = 40, opts?: HandleOpts): Handle => {
  // `polar` with `circular` policy: c and r fixed, writes only update θ.
  return handleFn(polarLens(shape.center, radius, shape.rotate, "circular"), {
    cursor: "grab",
    ...opts,
  });
};

/** Uniform-scale knob along +x at `radius * scale.x`; drag x-distance writes
 *  both scale axes. */
const scaleHandle = (shape: AnyShape & Has<"scale">, radius = 40, opts?: HandleOpts): Handle => {
  // Reads center and scale; writes only scale.
  const pos = Vec.lens(
    [shape.center, shape.scale] as const,
    vals => ({ x: vals[0].x + radius * vals[1].x, y: vals[0].y }),
    (target, vals) => {
      const k = Math.max(0.05, Math.abs(target.x - vals[0].x) / radius);
      return [undefined, { x: k, y: k }];
    },
  );
  return handleFn(pos, { cursor: "ew-resize", ...opts });
};

/** Handle constrained to a Path: each drag projects the pointer onto the path
 *  and sets `t` to the nearest parameter (re-projects, so animated paths work). */
const tOnPath = (p: Path, t: Signal<number>, opts?: HandleOpts & { samples?: number }): Handle => {
  const N = opts?.samples ?? 64;
  const project = (target: { x: number; y: number }) => {
    let bestT = 0;
    let bestD = Number.POSITIVE_INFINITY;
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
    [t] as const,
    ([tv]) => p.pointAt(tv).value,
    target => [project(target)],
  );
  return handleFn(pos, opts);
};

/** `handle(point)` is the atom; `.move`, `.centroid`, etc. are sugar. */
export const handle = Object.assign(handleFn, {
  move,
  anchor,
  centroid: centroidHandle,
  midpoint,
  rotate,
  scale: scaleHandle,
  tOnPath,
});
