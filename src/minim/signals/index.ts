// Reactive signals — the irreducible reactivity primitives.
//
// Layout:
//   signal.ts      — Signal/Computed/Lens engine (vendored
//                    preact-signals + our `Lens<T>` subclass).
//   cell.ts        — `Cell<T>` / `ReadonlyCell<T>` — the unified
//                    user-facing type pair, plus `cell()` factory,
//                    `derive`, `not`, and the type-level surface for
//                    the struct framework (`StructType`, `WriteOf`,
//                    `ReadOf`, `NestedMap`, `NestedInput`).
//   arg.ts         — `Val<T>` (literal | reactive cell | thunk) and
//                    `toSig` / `when` bridges.
//   suspensions.ts — `untilChange / untilEvent / untilPromise / race`
//                    plus framework-internal `untilTrue` used by
//                    `play(cell)` / `.until(cell)`.
//   tween.ts       — `Play<R>` fluent vocabulary, `play()` entry
//                    point, `Playable<R>` input type, AND `Tween<T>`
//                    (since `Tween<T> extends Play<void>`). One file
//                    because they share the `_rewrap`-based subclass-
//                    preserving design.
//   compose.ts     — `loop(factory)` + `every(sec, fn)` — distinct
//                    shapes that don't fit the `play(...)` signature.
//   struct.ts      — runtime for the struct framework. Produces high-
//                    performance chainable cells (axes, lifted ops,
//                    lazy getters, per-struct `.to`, `[ALGEBRA]`).

// ── signal engine ─────────────────────────────────────────────────
//
// `Signal` / `Computed` classes and the `signal` / `computed` / `lens`
// factories are exposed because the struct framework runtime needs them
// for prototype work and `instanceof` checks. Public consumers should
// reach for `cell` / `cell.derived` / `cell.lens` instead.
//
// `SignalOptions` / `EffectOptions` are not re-exported — they're
// preact's internal config types and have no external callers.
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
} from "./signal";

// ── cell types + factory ──────────────────────────────────────────
//
// `NestedMap` / `NestedInput` are framework-internal type-system
// bookkeeping; they're consumed inside `cell.ts` and `struct.ts` but
// never named in user code.
export {
  cell,
  derive,
  not,
  type Cell,
  type ReadonlyCell,
  type CellOptions,
  type StructType,
  type WriteOf,
  type ReadOf,
} from "./cell";

// ── Val<T> bridge ─────────────────────────────────────────────────
//
// Two canonical normalisers for `Val<T>`:
//   toSig(v)     → ReadonlyCell<T>      ("give me a cell")
//   asReader(v)  → () => T              ("give me a thunk; no signal alloc for literals")
//
// Every Val-consuming callsite in the library funnels through one
// of these. No bespoke dispatch elsewhere.
export { toSig, asReader, when, type Val } from "./arg";

// ── suspensions ───────────────────────────────────────────────────
//
// `untilTrue` is framework-internal — it's consumed by `play(cell)`
// and `.until(cell)` (the "wait truthy" branch of `playableGen`).
// Public code says `play(sig)` / `.until(sig)` / `.until(not(sig))`
// for the falsy case.
export {
  untilChange,
  untilEvent,
  untilPromise,
  race,
} from "./suspensions";

// ── play + tween (the fluent surface) ─────────────────────────────
//
// `LERP` symbol, `scaledChild`, `sleepGen`, `yieldableGen` are
// framework-internal — used by `struct.ts` and `compose.ts` only.
// Not re-exported.
export {
  play,
  tween,
  lerpable,
  type Play,
  type Playable,
  type Tween,
  type Easing,
  type Lerp,
} from "./tween";

// ── compose (distinct-shape factories) ────────────────────────────
export { loop, every } from "./compose";

// ── struct framework ──────────────────────────────────────────────
//
// Two equivalent entry points:
// `defineStruct({...})` — flat config; capabilities (`algebra`, `lerp`,
// `metric`) are first-class keys. `registerCapability` stamps custom
// capability slots onto an already-built struct.
export {
  defineStruct,
  registerCapability,
  type StructConfig,
  type VectorSpace,
} from "./struct";
