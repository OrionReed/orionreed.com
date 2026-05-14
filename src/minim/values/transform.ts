// Transform — the animatable pose, declared via the struct framework.
// Used as the canonical animatable surface on `Shape` and exported as
// a public primitive for users who want to compose their own scene
// graphs / poses around the same machinery.
//
// `.nested({translate, scale, origin: Vec})` puts every field in its
// own per-field signal (full SoA), so per-axis writes are isolated.
// `.lerp` enables `transform.to(target, dur)` for whole-pose tweens.

import { struct, type WriteOf, type ReadOf } from "@minim/signals";
import { Vec, type V } from "./vec";
import { Num } from "./num";

export type Transform = {
  translate: V;
  rotate: number;
  scale: V;
  origin: V;
  opacity: number;
};

const TR_DEFAULTS: Transform = {
  translate: { x: 0, y: 0 },
  rotate: 0,
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  opacity: 1,
};

// All five fields are nested struct cells. Vec fields get the Vec
// surface (`.x`/`.y`/`.add`/`.lerp`/…); scalar fields get the Num
// surface — most importantly, `.to(target, dur)` so e.g.
// `shape.opacity.to(0, 0.3)` works (Num.signal has `.to` installed
// per-struct; plain Signal<number> does not).
const N_MAP = {
  translate: Vec,
  scale: Vec,
  origin: Vec,
  rotate: Num,
  opacity: Num,
};

export const Transform = struct<Transform>("Transform", TR_DEFAULTS)
  .equals(
    (a, b) =>
      a.translate.x === b.translate.x &&
      a.translate.y === b.translate.y &&
      a.rotate === b.rotate &&
      a.scale.x === b.scale.x &&
      a.scale.y === b.scale.y &&
      a.origin.x === b.origin.x &&
      a.origin.y === b.origin.y &&
      a.opacity === b.opacity,
  )
  .nested(N_MAP)
  .ops({
    /** Component-wise lerp; enables `transform.to(target, dur)`. */
    lerp: (a, b: Transform, t: number): Transform => ({
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
  })
  .build();

/** Sugar for `Transform.signal({...})` — same function, shorter name.
 *  Accepts smart-adopted field inputs (literal / Signal / thunk / matching
 *  Reactive). */
export const transform = Transform.signal;

/** Writable reactive Transform — broad rw-flavor type. */
export type Tr = WriteOf<typeof Transform>;

/** Read-only reactive Transform. */
export type DerivedTr = ReadOf<typeof Transform>;
