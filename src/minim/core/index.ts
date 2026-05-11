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
  tween,
  type ReadonlySignal,
  type Tween,
  type Easing,
  type Duration,
} from "./signal";

export {
  toSig,
  when,
  type Arg,
  type NumSig,
  type ResolveSig,
} from "./arg";

export { type Vec } from "./vec";

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
