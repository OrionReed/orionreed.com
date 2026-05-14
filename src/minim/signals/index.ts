// Reactive signals — the irreducible reactivity primitives.
//
// Layout:
//   signal.ts   — Signal/Computed/Lens engine (vendored preact-signals +
//                 our `Lens<T>` subclass). The reactive kernel; everything
//                 else builds on it.
//   cell.ts     — `Cell<T>` / `ReadonlyCell<T>` — the unified user-facing
//                 type pair, plus `cell()` factory and the type-level
//                 surface for the struct framework (`StructType`,
//                 `WriteOf`, `ReadOf`, `NestedMap`, `NestedInput`).
//   tween.ts    — `Chained<R>` fluent generator vocabulary AND `Tween<T>`
//                 (since `Tween<T> extends Chained<void>`). One file: they
//                 share the `_rewrap`-based subclass-preserving design.
//   struct.ts   — runtime for the struct framework: `struct(name,
//                 defaults).ops({...}).build()`. Produces high-performance
//                 chainable cells (axes, lifted ops, lazy getters,
//                 per-struct `.to`, `[ALGEBRA]` slot).
//
// Users copying this folder get a complete reactive layer they can read
// and modify without bouncing between directories.

// ── signal engine ─────────────────────────────────────────────────
export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  lens,
  Signal,
  Computed,
  type ReadonlySignal,
  type SignalOptions,
  type EffectOptions,
} from "./signal";

// ── cell types + factory ──────────────────────────────────────────
export {
  cell,
  derive,
  type Cell,
  type ReadonlyCell,
  type CellOptions,
  type StructType,
  type NestedMap,
  type NestedInput,
  type WriteOf,
  type ReadOf,
} from "./cell";

// ── tween + chain ─────────────────────────────────────────────────
export {
  chain,
  tween,
  lerpable,
  LERP,
  scaledChild,
  sleepGen,
  yieldableGen,
  type Chained,
  type Tween,
  type Easing,
  type Duration,
  type Lerp,
} from "./tween";

// ── struct framework ──────────────────────────────────────────────
export { struct } from "./struct";
