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
  tween, spring, toward, from, holding, driven,
  play, untilTrue,
  defineTrait, lerpImpl,
  type LerpMethods,
} from "./lerp";

// ── Built-in value types ───────────────────────────────────────────
export {
  Num, num, type NumValue,
  Vec, vec, type VecValue,
  Color, rgb, rgba, type ColorValue,
  Box, box, type BoxValue,
  Transform, transform, type TransformValue, type TransformInit,
  mean,
} from "./values";
