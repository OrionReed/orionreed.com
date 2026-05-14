// Transform — the animatable pose. Canonical animatable surface on
// `Shape`; also exported as a public primitive for users who want to
// compose their own scene graphs / poses around the same machinery.
//
// `.nested({translate, scale, origin: Vec, rotate: Num, opacity: Num})`
// puts every field in its own per-field signal (full SoA), so per-axis
// writes are isolated. Vec fields get the Vec surface (`.x`/`.y`/
// `.add`/`.lerp`/…); scalar fields get the Num surface — most
// importantly, `.to(target, dur)` so `shape.opacity.to(0, 0.3)` works.
//
// Component-wise `algebra` + `lerp` + `metric` enable whole-pose
// behaviors: `spring(shape.transform, targetPose)`, `mean(...transforms)`,
// `transform.to(target, dur)`, etc.

import {
  defineStruct,
  type ReadOf,
  type WriteOf,
} from "@minim/signals";
import { Vec } from "./vec";
import { Num } from "./num";

/** Plain pose shape. The `Transform` const wraps this in a reactive
 *  cell; `Transform.Writable` / `Transform.Readonly` name the cell
 *  flavors. */
export interface Transform {
  translate: Vec;
  rotate: number;
  scale: Vec;
  origin: Vec;
  opacity: number;
}

const TR_DEFAULTS: Transform = {
  translate: { x: 0, y: 0 },
  rotate: 0,
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  opacity: 1,
};

export const Transform = defineStruct({
  name: "Transform",
  defaults: TR_DEFAULTS,
  equals: (a, b) =>
    a.translate.x === b.translate.x &&
    a.translate.y === b.translate.y &&
    a.rotate === b.rotate &&
    a.scale.x === b.scale.x &&
    a.scale.y === b.scale.y &&
    a.origin.x === b.origin.x &&
    a.origin.y === b.origin.y &&
    a.opacity === b.opacity,
  nested: {
    translate: Vec,
    scale: Vec,
    origin: Vec,
    rotate: Num,
    opacity: Num,
  },
  // ── Capabilities — component-wise, including rotate + opacity ──
  algebra: {
    add: (a, b) => ({
      translate: { x: a.translate.x + b.translate.x, y: a.translate.y + b.translate.y },
      rotate: a.rotate + b.rotate,
      scale: { x: a.scale.x + b.scale.x, y: a.scale.y + b.scale.y },
      origin: { x: a.origin.x + b.origin.x, y: a.origin.y + b.origin.y },
      opacity: a.opacity + b.opacity,
    }),
    sub: (a, b) => ({
      translate: { x: a.translate.x - b.translate.x, y: a.translate.y - b.translate.y },
      rotate: a.rotate - b.rotate,
      scale: { x: a.scale.x - b.scale.x, y: a.scale.y - b.scale.y },
      origin: { x: a.origin.x - b.origin.x, y: a.origin.y - b.origin.y },
      opacity: a.opacity - b.opacity,
    }),
    scale: (a, k) => ({
      translate: { x: a.translate.x * k, y: a.translate.y * k },
      rotate: a.rotate * k,
      scale: { x: a.scale.x * k, y: a.scale.y * k },
      origin: { x: a.origin.x * k, y: a.origin.y * k },
      opacity: a.opacity * k,
    }),
  },
  /** Component-wise lerp; enables `transform.to(target, dur)`. */
  lerp: (a, b, t) => ({
    translate: {
      x: a.translate.x + (b.translate.x - a.translate.x) * t,
      y: a.translate.y + (b.translate.y - a.translate.y) * t,
    },
    rotate: a.rotate + (b.rotate - a.rotate) * t,
    scale: {
      x: a.scale.x + (b.scale.x - a.scale.x) * t,
      y: a.scale.y + (b.scale.y - a.scale.y) * t,
    },
    origin: {
      x: a.origin.x + (b.origin.x - a.origin.x) * t,
      y: a.origin.y + (b.origin.y - a.origin.y) * t,
    },
    opacity: a.opacity + (b.opacity - a.opacity) * t,
  }),
  /** Component-wise distance — sum of per-field |Δ|. Enables
   *  `spring(shape.transform, target, { precision })` auto-settle. */
  metric: (a, b) =>
    Math.hypot(
      a.translate.x - b.translate.x,
      a.translate.y - b.translate.y,
      a.rotate - b.rotate,
      a.scale.x - b.scale.x,
      a.scale.y - b.scale.y,
      a.origin.x - b.origin.x,
      a.origin.y - b.origin.y,
      a.opacity - b.opacity,
    ),
});

/** Sugar for `Transform.signal({...})` — same function, shorter name.
 *  Accepts smart-adopted field inputs (literal / Cell / thunk). */
export const transform = Transform.signal;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Transform {
  /** Writable reactive Transform. */
  export type Writable = WriteOf<typeof Transform>;
  /** Read-only reactive Transform. */
  export type Readonly = ReadOf<typeof Transform>;
  /** Either flavor. */
  export type Like = Writable | Readonly;
}
