// Reactive value-types — `Vec`, `Box`, `Color`, `Matrix2D`, `Num`,
// `Transform`. Each one follows the same naming pattern:
//
//   interface Foo        — plain JS shape (`{x, y}`, `{r, g, b, a}`, …)
//   const Foo            — registered struct (`.signal/.derived/.lens/.is`)
//   const foo(...)       — factory shorthand (when useful)
//   Foo.Writable         — writable cell type
//   Foo.Readonly         — readonly cell type
//   Foo.Like             — either flavor (Writable | Readonly)
//   Foo.Resolve<A>       — per-input narrowing (Vec, Num only)
//
// Generic capabilities (`algebra`/`lerp`/`metric`) and free functions
// (`mean`, `algebraOf`, `metricOf`, `spring`, `oscillate`, `drift`,
// `attract`) operate uniformly across any registered struct.

// ── Vec ─────────────────────────────────────────────────────────
export { Vec, vec, polar, isVec, vecEquals } from "./vec";

// ── Box ─────────────────────────────────────────────────────────
export {
  Box,
  box,
  boxAt,
  expandBox,
  unionBox,
  boxEdgeFrom,
  isBox,
  type BoxLike,
} from "./box";

// ── Color ───────────────────────────────────────────────────────
export { Color, rgb, rgba } from "./color";

// ── Matrix2D ────────────────────────────────────────────────────
export {
  Matrix2D,
  matrix,
  identity,
  fromTranslate,
  fromScale,
  fromRotate,
  isIdentity,
  multiply,
  invert,
  transformPoint,
  transformBox,
  compose,
  toString as matrixToString,
} from "./matrix";

// ── Num ─────────────────────────────────────────────────────────
export { Num, num } from "./num";

// ── Transform ───────────────────────────────────────────────────
export { Transform, transform } from "./transform";

// ── Algebra + capabilities + aggregates + behaviors ─────────────
export { type VectorSpace, algebraOf, metricOf } from "./algebra";
export { mean } from "./aggregates";
export {
  spring,
  oscillate,
  drift,
  attract,
  type SpringOpts,
} from "./behaviors";

// ── Cross-class composition helpers ─────────────────────────────
export { delegate, delegateLazy, type DelegateOpts } from "./delegate";

// ── Spatial constants ───────────────────────────────────────────
export { Anchor, Dir } from "./anchor";

// ── Anim adapters ───────────────────────────────────────────────
//
// `clockSignal(anim)` projects `anim.clock` (a plain number) into
// a `ReadonlyCell<number>`. Anim itself has no signal dependency;
// users who want reactive clock access bridge through this adapter.
export { clockSignal } from "./anim-clock";
