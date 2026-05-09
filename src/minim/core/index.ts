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
  type Animator,
  type Awaitable,
  type Yieldable,
  type Span,
  type Trace,
} from "./anim";

export { EventBus } from "./events";

export { untilChange, onceEvent, fromPromise } from "./awaitables";

export {
  timeline,
  sequential,
  type Clip,
  type Timeline,
  type TimelineOf,
} from "./timeline";
