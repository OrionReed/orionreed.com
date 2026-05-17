// Core: the bare generator runtime + signal-free utilities.
//
// Nothing in this folder depends on `@minim/signals`. Anim is the
// scheduler; `drive` is the frame-loop substrate; `all` / `rand` are
// signal-free generator combinators. Easings are pure functions.
// `composability` ships userland generator wrappers (mapDt, tap, …)
// for time-scope, observation, and recording.
//
// The signal layer (cells, struct framework, tween, `Play`-returning
// factories) lives in `@minim/signals`. The bridge type `Val<T>` and
// the suspension adapters `until*` / `race` also live there because
// they pull the signal engine.

export {
  Anim,
  isGen,
  asGen,
  detach,
  type Animator,
  type AnimObserver,
  type Yieldable,
  type Detach,
  type SpawnFn,
  type SuspendFn,
  type Wake,
  type PayloadOf,
} from "./anim";

export { all, drive, rand, spawnYieldable, suspend } from "./compose";

export { linear, easeIn, easeOut, easeInOut } from "./easings";

export {
  mapDt,
  tap,
  trace,
  withTimeout,
  record,
  replay,
  reverse,
  forks,
  type TraceFrame,
} from "./composability";
