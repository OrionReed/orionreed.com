// Core: pure generator runtime + low-level utilities. Independent of
// signals (`@minim/signals/`) and value types (`@minim/values/`).
//
// The reactive primitives (`cell`, `Cell`, `ReadonlyCell`, struct
// framework, tween, chain) live in `@minim/signals/`. The `@minim`
// top-level barrel re-exports everything; consumers usually import
// from there.

// ── Anim runtime + generator primitives ───────────────────────────
export {
  Anim,
  asGen,
  isGen,
  suspend,
  type Animator,
  type AnimObserver,
  type Yieldable,
  type SpawnFn,
} from "./anim";

// ── Suspensions (signal-aware adapters live alongside the
//    signal-agnostic ones — see `suspensions.ts` for the split. The
//    signal-aware adapters import `effect` from `@minim/signals`). ──
export {
  untilChange,
  untilTrue,
  untilFalse,
  untilEvent,
  untilPromise,
  race,
} from "./suspensions";
// `endOn(trigger, work)` and `startOn(trigger, work)` are no longer
// publicly exported — use `chain(work).until(trigger)` (from
// `@minim/signals`) and `after(trigger, work)` instead.

// ── Generator combinators ─────────────────────────────────────────
export {
  all,
  sequence,
  parallel,
  loop,
  sleep,
  after,
  every,
  rand,
} from "./compose";

// ── Frame-loop substrate ──────────────────────────────────────────
export { drive } from "./drive";

// ── Val coercions (signal bridge) ─────────────────────────────────
//
// `Val<T>` = literal | reactive cell | thunk; the universal "value
// source" type for reactive args.
export { toSig, when, type Val } from "./arg";

// ── Easings ───────────────────────────────────────────────────────
export { linear, easeIn, easeOut, easeInOut } from "./easings";

// ── Snapshot + counter ────────────────────────────────────────────
export { snapshot, counter } from "./store";

// ── Back-compat: signal-layer re-exports ─────────────────────────
//
// These live in `@minim/signals` now. The re-exports here let
// pre-restructure consumers keep importing from `@minim/core` while
// the codebase migrates. New code should import directly from
// `@minim/signals` for clarity.
export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  lens,
  Signal,
  Computed,
  cell,
  derive,
  tween,
  lerpable,
  chain,
  struct,
  LERP,
  type ReadonlySignal,
  type SignalOptions,
  type EffectOptions,
  type Cell,
  type ReadonlyCell,
  type CellOptions,
  type StructType,
  type NestedMap,
  type NestedInput,
  type WriteOf,
  type ReadOf,
  type Chained,
  type Tween,
  type Easing,
  type Duration,
  type Lerp,
} from "@minim/signals";
