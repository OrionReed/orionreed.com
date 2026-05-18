// handle.* — writable derived shapes: small draggable circles wired to
// a Vec (or Signal-pair). Reads come from the source; writes go back.
//
// The atom is `handle(point)`. Every other helper is sugar that picks
// the writable source — `handle.move(shape)` wires to `shape.center`,
// `handle.centroid(...shapes)` wires to the centroid lens, etc. Same
// algebra as `centroid(...)`: a lens with a visible UI shadow.
//
// Every `handle(...)` returns a `Handle` (a `Shape` with `.dragging:
// Signal<boolean>`). Use the signal to coordinate animations with the
// drag — e.g. `play(spring(...)).at(() => h.dragging.value ? 0 : 1)`
// freezes the spring while the user is pressing the handle.
//
// All handles are `aside: true` (no autofit contribution) and themable
// via the `--minim-handle` CSS var.

import { derived, signal, Signal, Vec, mean } from "@minim/signals";
import { type AnyShape, type Has } from "./shape";
import { Circle, type CircleOpts } from "./circle";
import { draggable } from "./interaction";
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

/** Draggable circular handle with observable drag state.
 *
 *  `Handle` IS a `Circle` — same DOM, same Shape semantics — plus a
 *  `dragging: Signal<boolean>` that flips true on pointerdown and
 *  false on pointerup/cancel. Use it in `at(...)`, `when(...)`, etc.
 *  to coordinate animations with user interaction:
 *
 *      const h = s(handle(target));
 *      anim.start(function*() {
 *        yield* play(spring(target, REST)).at(() => h.dragging.value ? 0 : 1);
 *      });
 */
export class Handle extends Circle {
  readonly dragging: Signal<boolean>;
  constructor(target: Vec, opts: HandleOpts = {}) {
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

    // Capture the grab offset on pointerdown so the handle stays under
    // the cursor at the grab point — without this, the target snaps so
    // its origin is exactly at the pointer, which feels jumpy for
    // anything other than tiny handles.
    let dx = 0;
    let dy = 0;
    this.on("pointerdown", (e) => {
      const local = this.toLocal(e as PointerEvent);
      const v = target.value;
      dx = local.x - v.x;
      dy = local.y - v.y;
    });
    const stopDrag = draggable(
      this,
      (local) => {
        target.value = { x: local.x - dx, y: local.y - dy };
      },
      (active) => {
        this.dragging.value = active;
      },
    );
    this.disposers.push(stopDrag);
  }
}

function handleFn(target: Vec, opts: HandleOpts = {}): Handle {
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
  handleFn(mean(...shapes.map((s) => s.center)));

/** Drag handle at the midpoint of two writable Points — drags both
 *  along with it. */
const midpoint = (a: Vec, b: Vec, opts?: HandleOpts): Handle =>
  handleFn(mean(a, b), opts);

/** Rotation knob orbiting the shape's center at `radius`. The knob
 *  position is `center + (r cos θ, r sin θ)` for `θ = shape.rotate`;
 *  drag the knob to write θ. */
const rotate = (
  shape: AnyShape & Has<"rotate">,
  radius = 40,
  opts?: HandleOpts,
): Handle => {
  const pos = derived(
    Vec,
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
  shape: AnyShape & Has<"scale">,
  radius = 40,
  opts?: HandleOpts,
): Handle => {
  const pos = derived(
    Vec,
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
): Handle => {
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
  const pos = derived(
    Vec,
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
