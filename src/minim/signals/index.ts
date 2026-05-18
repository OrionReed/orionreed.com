// signals — reactive cells + signals→generators bridge.
//
// Layered surface:
//   ./signal     Signal / Computed / Lens + effect / batch / untracked
//   ./traits    LINEAR / LERP / METRIC / EQUALS slots + accessors
//   ./derive    BaseChain / derived / field / bindFields / ReactiveInit
//   ./lerp      Tween, tween/spring/toward/from/holding/driven, play, defineTrait
//   ./values/*  Num / Vec / Color / Box / Transform built-in cells
//
// The signal-free runtime (Anim, drive, suspend, race, etc.) lives in
// `../core` — it has no signal dependency and is re-exported separately.

// ── Engine ─────────────────────────────────────────────────────────
export {
  Signal,
  Computed,
  signal, computed, lens, effect, batch, untracked,
  value, isSignal,
  type Lens,
  type Read,
  type Val,
  type SignalOptions,
} from "./signal";

// ── Traits ─────────────────────────────────────────────────────────
export {
  LINEAR, LERP, METRIC, EQUALS,
  classOf,
  linearOf, lerpOf, metricOf, equalsOf,
  requireLinear, requireLerp, requireMetric, requireEquals,
  type Linear, type Lerp, type Metric, type Equals,
  type ValueClass,
} from "./traits";

// ── Composition primitives ─────────────────────────────────────────
export {
  BaseChain,
  derived,
  field,
  bindFields,
  type ReactiveInit,
} from "./derive";

// ── Lerp / temporal cell methods ───────────────────────────────────
export {
  Tween,
  tween, spring, toward, follow, holding, driven,
  oscillate, attract, drift,
  play, when, not, untilChange,
  loop, every,
  defineTrait, lerpImpl,
  type LerpMethods,
  type SpringOpts,
  type PlayTrigger,
} from "./lerp";

// Easings + signal-free runtime — re-exported for the common case of
// "I'm in signals-land, give me everything to author."
export {
  // Runtime engine
  Anim, asGen, detach, isGen,
  type Animator, type AnimObserver, type Detach,
  type Resume, type SpawnFn, type Suspend,
  type Wake, type Yieldable,
  // Combinators (signal-free)
  drive, suspend, all, race, rand, mapDt, withScale,
  untilEvent, untilPromise, attachRaf,
  // Easings
  type Easing, linear, easeIn, easeOut, easeInOut,
} from "../core";

// ── Anim → reactive clock ──────────────────────────────────────────
export { clockSignal } from "./clock";

// ── Built-in value types ───────────────────────────────────────────
export {
  Num, num, type NumValue,
  Vec, vec, polar, type VecValue,
  Color, rgb, rgba, type ColorValue,
  Box, box, type Boxed, type BoxValue,
  Transform, transform, type TransformValue, type TransformInit,
  Matrix2D, matrix, type Matrix2DValue,
  identity, fromTranslate, fromScale, fromRotate,
  isIdentity, multiply, invert, determinant,
  transformPoint, transformBox, compose,
  matrixToString,
  Anchor, Dir,
  mean, combine,
} from "./values";

// ── Pure value-math (for deep imports / interop) ───────────────────
export * as VecMath from "./values/vec";
export * as BoxMath from "./values/box";
export * as ColorMath from "./values/color";
export * as MatrixMath from "./values/matrix";
export * as NumMath from "./values/num";
export * as TransformMath from "./values/transform";
