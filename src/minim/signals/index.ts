// Reactive signals — the irreducible reactivity primitives.
//
// Layout:
//   signal.ts      — Signal/Computed/Lens engine (vendored
//                    preact-signals + our `Lens<T>` subclass).
//   cell.ts        — `Cell<T>` / `ReadonlyCell<T>` — the unified
//                    user-facing type pair, plus `cell()` factory and
//                    the type-level surface for the struct framework
//                    (`StructType`, `WriteOf`, `ReadOf`, `NestedMap`,
//                    `NestedInput`).
//   arg.ts         — `Val<T>` (literal | reactive cell | thunk) and
//                    `toSig` / `when` bridges. Pulled into the signals
//                    layer because they require the signal engine to
//                    wrap literals.
//   suspensions.ts — `untilChange / untilTrue / untilFalse` (use
//                    `effect()`), plus the signal-free `untilEvent /
//                    untilPromise / race`. All grouped here so the
//                    "suspend until X" vocabulary lives in one place.
//   tween.ts       — `Chained<R>` fluent vocabulary AND `Tween<T>`
//                    (since `Tween<T> extends Chained<void>`). One
//                    file because they share the `_rewrap`-based
//                    subclass-preserving design.
//   compose.ts     — Chained-returning factories (`sequence`,
//                    `parallel`, `loop`, `sleep`, `after`, `every`).
//   struct.ts      — runtime for the struct framework. Produces high-
//                    performance chainable cells (axes, lifted ops,
//                    lazy getters, per-struct `.to`, `[ALGEBRA]`).

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

// ── Val<T> bridge ─────────────────────────────────────────────────
export { toSig, when, type Val } from "./arg";

// ── suspensions ───────────────────────────────────────────────────
export {
  untilChange,
  untilTrue,
  untilFalse,
  untilEvent,
  untilPromise,
  race,
} from "./suspensions";

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

// ── compose (Chained factories) ───────────────────────────────────
export { sleep, parallel, sequence, loop, after, every } from "./compose";

// ── struct framework ──────────────────────────────────────────────
export { struct } from "./struct";
