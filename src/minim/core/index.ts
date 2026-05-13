// Core: reactivity (`cell`) + time (Anim + generators) + low-level
// utilities. The `@minim/core` barrel re-exports everything used by
// other packages — including framework-internal preact things
// (`Signal` class, `signal/computed/lens` factories) which downstream
// `@minim/values` and `@minim/shapes` need for prototype machinery.

// ── Reactive primitives ────────────────────────────────────────────
//
// `cell` is the unified user-facing primitive:
//   cell(v)                — writable
//   cell.derived(fn)       — read-only
//   cell.lens(read, w)     — writable lens
// `Cell<T, W>` is the type. `Signal` / `signal` / `computed` / `lens`
// (preact internals) are exposed for framework code that needs the
// classes for `instanceof` / prototype work — public consumers should
// reach for `cell` instead.
export { cell, type Cell, type ReadonlyCell, type RW } from "./cell";
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
export { pulse } from "./clocks";

// ── Anim + suspensions + composers + drive ────────────────────────
export {
  Anim,
  asGen,
  isGen,
  suspend,
  type Animator,
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
  endOn,
  startOn,
} from "./suspensions";
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

// ── Identity / cross-prose marker ──────────────────────────────────
export {
  marker,
  palette,
  hover,
  getMarker,
  registerMarker,
  type Marker,
} from "./marker";
