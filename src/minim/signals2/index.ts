// ── minim/signals2 — the next reactive system ───────────────────────
//
// Lives alongside the current `signals/` folder. Both work; you can
// migrate file-by-file. When `signals2/` is solid and consumed by
// every dependent, drop `signals/`.
//
// Architectural shape:
//
//   engine.ts    — vendored alien-signals (~470 LOC, MIT). The
//                  irreducible reactive graph: signal, computed,
//                  effect, effectScope, batch, trigger, is*.
//
//   cell.ts      — Cell<T> + Type<T> + defineType. A cell IS the
//                  engine signal function with a per-type prototype
//                  attached. `v()` reads, `v(x)` writes, `v.peek()`
//                  reads untracked, `v.x` is a lazy axis, `v.add(b)`
//                  is a method, `v.type` is the Type for generic
//                  dispatch.
//
//   values.ts    — Num, Vec, Transform as plain TypeConfig objects.
//                  Transform declares ZERO algebra/lerp/metric — they
//                  compose mechanically from its `nested: { … }` map.
//
//   generics.ts  — `mean<T>`, `lerp<T>`, `distance<T>`, `springStep<T>`
//                  Dispatch via `cell.type.algebra` etc.
//                  User capabilities work by direct property stamping.
//
// Tests:
//   _correctness.test.ts  — 51 glitch-free / diamond / nested-effect /
//                           batching / scope / trigger assertions
//   _generics.test.ts     — 21 capability-dispatch assertions
//
// Both pass clean. Run with:
//   node node_modules/.bin/vite-node src/minim/signals2/_correctness.test.ts
//   node node_modules/.bin/vite-node src/minim/signals2/_generics.test.ts

// ── Engine primitives ───────────────────────────────────────────────
export {
  signal, computed, effect, effectScope, trigger,
  startBatch, endBatch,
  getActiveSub, setActiveSub, getBatchDepth,
  isSignal, isComputed, isEffect, isEffectScope,
  ReactiveFlags,
  type SignalFn,
  type ReactiveNode,
} from "./engine";

// ── Cell + Type ─────────────────────────────────────────────────────
export {
  struct,
  cell,
  valOf,
  RESERVED_NAMES,
  type Cell,
  type RO,
  type Val,
  type Type,
  type StructInput,
  type Linear,
  type Storage,
  type FieldSpec,
} from "./cell";

// ── Generic capability-driven ops ───────────────────────────────────
export {
  mean,
  lerp,
  distance,
  springStep,
  serialise,
  type Serialise,
} from "./generics";

// ── Continuous behaviors (generator-driven) ────────────────────────
export {
  spring,
  oscillate,
  attract,
  drift,
  type SpringOpts,
} from "./behaviors";

// ── Value types ─────────────────────────────────────────────────────
export {
  Num,
  Vec, vec, type V,
  Color, rgb, rgba,
  Box, box, expandBox, unionBox, boxEdgeFrom, boxAt, isBox, type BoxLike,
  Matrix2D, mat,
  identity, fromTranslate, fromScale, fromRotate, isIdentity,
  multiplyMatrix, invertMatrix, transformPoint, transformBox,
  composeMatrix, matrixToString,
  Transform, type Tr,
} from "./values";
