// Public surface for r5. Aim: small, composable, no per-value-class
// type aliases. Writability is a generic modifier (`Writable<R>`).

// ─── Engine ───────────────────────────────────────────────────────
export {
  Signal,
  signal, computed, lens, computedCls, lensCls,
  effect, batch, untracked,
  isSignal, isComputed, isLens,
  value,
  type Read, type Val, type Of,
  type SignalOptions,
  type WritableBrand,
} from "./signal";

// ─── Traits ───────────────────────────────────────────────────────
export {
  type Linear, type Lerp, type Metric, type Equals,
  type Traits, type TraitDict,
  requireLinear, requireLerp, requireMetric, requireEquals,
} from "./traits";

// ─── Ops (for value-class authors) ────────────────────────────────
export { type Op, applyOp1, applyOp2 } from "./ops";

// ─── Writable modifier ────────────────────────────────────────────
export {
  type Writable,
  type WritableOf,
  invertibles,
} from "./writable";

// ─── Value classes ────────────────────────────────────────────────
export { Num, num } from "./values/num";
export { Vec, vec } from "./values/vec";
export { Box, box } from "./values/box";
export { Transform, transform, type TransformInit } from "./values/transform";
export { Color, rgb, rgba } from "./values/color";
export {
  Matrix, matrix,
  identity, fromTranslate, fromScale, fromRotate,
  multiply, invert, determinant,
  transformPoint, transformBox, compose, toMatrixString,
  isIdentity,
} from "./values/matrix";
export { Anchor, Dir } from "./values/anchor";

// ─── Combinators ──────────────────────────────────────────────────
export { combine, mean } from "./values/multi";
export { hyperLens, type InversePolicy } from "./values/hyper";

// ─── Animators ────────────────────────────────────────────────────
export {
  Tween, tween, tweenStep, spring, toward, attract,
  wave, driven, when, not, untilChange, loop, every,
  play, type Play, type PlayTrigger, type SpringOpts,
} from "./anim";

// ─── Clock bridge ─────────────────────────────────────────────────
export { clockSignal } from "./clock";
