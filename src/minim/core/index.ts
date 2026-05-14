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
