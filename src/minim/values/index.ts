// Reactive value-types — `Vec`, `Box`, `Color`, `Matrix2D`, `Num`,
// `Transform`. Each ships:
//   - the struct value (e.g. `Vec`) for advanced use
//     (`.signal/.derived/.lens/.is/.isWritable`)
//   - a lowercase factory shorthand (`vec(x, y)`, `num(0)`, …)
//   - the plain value type alias (`V`, `Box`, `C`, `Matrix2D`, `Transform`)
//   - rw/ro flavor aliases where useful (`Point`/`DerivedPoint`)
//
// Plus the struct framework itself (`struct`, `Cell`, `StructType`),
// generic algebra (`mean`, `algebraOf`, `VectorSpace`), continuous
// behaviors (`spring`, `oscillate`, `drift`, `attract`), `delegate` for
// host-class boxlike forwarders, and `Anchor`/`Dir` spatial constants.

// ── Struct framework (runtime) ─────────────────────────────────────
//
// Type-level surface (`Cell`, `ReadonlyCell`, `StructType`, …) lives
// in `core/cell.ts` and is exported from `@minim/core`. This module
// just provides the `struct(...)` builder runtime.
export { struct } from "./struct";

// Re-export the type-level surface so `@minim/values` consumers can
// import everything they need from one place.
export {
  type Cell,
  type ReadonlyCell,
  type StructType,
  type WriteOf,
  type ReadOf,
  type NestedMap,
  type NestedInput,
} from "@minim/core";

// ── Vec ─────────────────────────────────────────────────────────
export {
  Vec,
  vec,
  polar,
  isPoint,
  vecEquals,
  type V,
  type Point,
  type DerivedPoint,
  type Pointlike,
  type ResolveVec,
} from "./vec";

// ── Box ─────────────────────────────────────────────────────────
export {
  Box,
  box,
  boxAt,
  expandBox,
  unionBox,
  boxEdgeFrom,
  isBox,
  type Boxlike,
} from "./box";

// ── Color ───────────────────────────────────────────────────────
export { Color, rgb, rgba, type C } from "./color";

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
export { Num, num, type N, type DerivedN } from "./num";

// ── Transform ───────────────────────────────────────────────────
export { Transform, transform, type Tr, type DerivedTr } from "./transform";

// ── Algebra + aggregates + behaviors ────────────────────────────
export { type VectorSpace, algebraOf } from "./algebra";
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
// `clockSignal(anim)` projects `anim.clockMs` (a plain number) into
// a `ReadonlySignal<number>`. Anim itself has no Signal dependency;
// users who want reactive clock access bridge through this adapter.
export { clockSignal } from "./anim-clock";
