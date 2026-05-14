// Core: reactivity (`cell`) + time (Anim + generators) + low-level
// utilities. The `@minim/core` barrel re-exports the public surface
// PLUS the framework-internal preact things (`Signal` class,
// `signal/computed/lens` factories) which downstream `@minim/values`
// and `@minim/shapes` need for prototype machinery. Public consumers
// reach for `cell` and the value-type cells (`num`, `vec`, …) instead.

// ── Reactive primitives ────────────────────────────────────────────
//
// Public surface:
//   cell(v)                — writable cell
//   cell.derived(fn)       — read-only cell
//   cell.lens(read, w)     — writable lens cell
//   derive(sig, fn)        — single-source derived cell (sugar)
//
// One name pair covers all reactive values:
//   Cell<T, O?, X?, G?, M?, N?>          — writable
//   ReadonlyCell<T, O?, X?, G?, M?, N?>  — read-only
//
// Defaults (all empty) make `Cell<T>` a plain writable signal; the
// struct framework (values/struct.ts) instantiates richer surfaces
// via specific generic args. Value-type files (`num.ts`, `vec.ts`,
// …) export short aliases (`N`, `Point`, …).
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

// Internal-but-needed: framework-prototype work uses `Signal` /
// `Computed` classes and the `signal`/`computed`/`lens` factories.
// Public callers should NOT import these — they're escape hatches
// for the struct framework and other layers that build on the
// preact primitives directly.
export {
  effect,
  batch,
  untracked,
  signal,
  computed,
  lens,
  Signal,
  Computed,
  type ReadonlySignal,
} from "./signal";

// ── Tween + easings + clocks ───────────────────────────────────────
//
// `.to(target, dur, ease?)` is installed per-struct (in `values/struct.ts`)
// — not on Signal.prototype. Importing `tween` is safe to do early
// (no global side-effects).
export {
  tween,
  makeTween,
  lerpable,
  type Tween,
  type Easing,
  type Duration,
  type Lerp,
  LERP,
} from "./tween";
export { linear, easeIn, easeOut, easeInOut } from "./easings";

// ── Anim + suspensions + composers + drive ────────────────────────
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
export {
  untilChange,
  untilTrue,
  untilFalse,
  untilEvent,
  untilPromise,
  race,
  firstN,
} from "./suspensions";
// `endOn(trigger, work)` and `startOn(trigger, work)` are no longer
// publicly exported — use `chain(work).until(trigger)` and
// `after(trigger, work)` instead (see `chain.ts` and `compose.ts`).
export {
  all,
  sequence,
  parallel,
  loop,
  sleep,
  after,
  every,
  transaction,
  rand,
} from "./compose";
export { chain, type Chained } from "./chain";
export { drive } from "./drive";

// ── Val coercions ──────────────────────────────────────────────────
//
// `Val<T>` = literal | Signal<T> | ReadonlySignal<T> | thunk; the
// universal "value source" type for reactive args. Named to match
// the values-layer (`Vec`, `Box`, `Num`, …).
export {
  toSig,
  when,
  type Val,
  type NumSig,
  type ResolveSig,
} from "./arg";

// ── Snapshot + counter ─────────────────────────────────────────────
export { snapshot, counter } from "./store";
