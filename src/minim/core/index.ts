// Core: the bare generator runtime + signal-free utilities.
//
// Nothing in this folder depends on `@minim/signals`. Anim is the
// scheduler; `drive` is the frame-loop substrate; `all` / `rand` are
// the signal-free generator combinators. Easings are pure functions.
//
// The signal layer (cells, struct framework, tween, `Play`-returning
// factories `play` / `loop` / `every`) lives in `@minim/signals`. The
// bridge type `Val<T>` and the suspension adapters `until*` / `race`
// also live there because they pull the signal engine.

// ── Anim runtime + generator primitives ───────────────────────────
export {
  Anim,
  isGen,
  suspend,
  type Animator,
  type AnimObserver,
  type Yieldable,
  type SpawnFn,
  type SuspendFn,
  type PayloadOf,
} from "./anim";
// `asGen` is internal — used by core/compose and signals/suspensions
// to lift Yieldables into Animators. Not in the public surface.

// ── Generator combinators (signal-free) ───────────────────────────
//
// `all(...)` keeps a typed-tuple return — the fluent `play([...])`
// from `@minim/signals` loses per-child typing, so the raw form stays
// here for callers that need it. `rand(...)` picks one branch
// uniformly without advancing the rest.
export { all, rand } from "./compose";

// ── Frame-loop substrate ──────────────────────────────────────────
export { drive } from "./drive";

// ── Easings ───────────────────────────────────────────────────────
export { linear, easeIn, easeOut, easeInOut } from "./easings";
