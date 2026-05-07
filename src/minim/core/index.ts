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

export { store, snapshot, type Store } from "./store";

export { Anim, type Animator, type Yieldable } from "./anim";

export { EventBus, type EventState } from "./events";

export {
  range,
  Timeline,
  timeline,
  durations,
  type Ranged,
  type TimelineEntry,
} from "./timeline";
