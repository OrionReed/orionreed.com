// Core: time + reactivity foundation. Layer-A (Anim) is the runtime;
// layer-B (signals + utilities) is the reactive substrate. Self-contained
// — the signal primitive is vendored. Pair with `../scene/` for the
// scene graph; pair with `../shapes/`, `../motion/` for the stdlibs.

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

export { counter } from "./counter";

export {
  toSig,
  when,
  type Arg,
  type NumSig,
  type ResolveSig,
} from "./arg";

export { type Vec } from "./vec";

export { snapshot } from "./store";

export {
  Anim,
  asGen,
  isGen,
  type Animator,
  type Awaitable,
  type Yieldable,
  type SpawnFn,
  type ObserveListeners,
} from "./anim";

export { EventBus } from "./events";

export {
  untilChange,
  untilTrue,
  onceEvent,
  fromPromise,
  race,
  until,
} from "./awaitables";

export {
  timeline,
  sequential,
  type Clip,
  type Timeline,
  type TimelineOf,
} from "./timeline";
