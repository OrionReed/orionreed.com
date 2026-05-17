// signals2 — reactive cells + animation runtime.
//
// Layered surface:
//   ./signal       Signal / Computed / Lens / effect / batch / untracked
//   ./traits       LINEAR / LERP / METRIC / EQUALS slots + accessors
//   ./derive       Chain / derived / field / bindFields / ReactiveInit
//   ./anim         Anim runtime, drive, suspend, fork, race, attachRaf
//   ./easings      pure easing curves
//   ./lerp         Tween, tween/spring/toward/from/holding/driven, play
//   ./values/*     Num / Vec / Color / Box / Transform built-in cells
//
// Most users want from this barrel; reach into individual files when
// you need internal types or per-type math fns.

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

// ── Animation runtime ─────────────────────────────────────────────
export {
  Anim,
  drive, suspend, fork, race, attachRaf,
  type Animator, type Yieldable, type SuspendFn, type SpawnFn, type PayloadOf,
} from "./anim";

// ── Easings ────────────────────────────────────────────────────────
export {
  type Easing, linear, easeIn, easeOut, easeInOut,
} from "./easings";

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
