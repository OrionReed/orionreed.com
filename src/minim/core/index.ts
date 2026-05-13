// Core: time (Anim) + reactivity (vendored signals) + utilities.
// Pair with `../scene/`, `../shapes/`, `../motion/`.

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  lens,
  Signal,
  type ReadonlySignal,
} from "./signal";

// Importing this module installs `Signal.prototype.to` and registers
// the tween types. Re-exported below.
export {
  tween,
  type Tween,
  type Easing,
  type Duration,
} from "./tween";

export {
  toSig,
  when,
  type Arg,
  type NumSig,
  type ResolveSig,
} from "./arg";

// Plain `{x, y}` value type. Renamed from `Vec` (which now refers to
// the registered struct value in `signals/vec`).
export type { V } from "../signals/vec";

export { lerpable } from "./tween";

export { snapshot, counter } from "./store";

export {
  Anim,
  asGen,
  isGen,
  suspend,
  type Animator,
  type Yieldable,
  type SpawnFn,
} from "./anim";

export { EventBus } from "./events";

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
  delay,
  transaction,
  rand,
} from "./compose";

export { drive } from "./drive";

export {
  timeline,
  sequential,
  type Clip,
  type Timeline,
  type TimelineOf,
} from "./timeline";
