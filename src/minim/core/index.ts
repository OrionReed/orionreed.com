// Core: time (Anim) + reactivity (`cell`) + utilities. Pair with
// `../scene/`, `../shapes/`, `../motion/`.

// `cell` is the unified reactive primitive:
//   cell(v)                — writable
//   cell.derived(fn)       — read-only
//   cell.lens(read, w)     — writable lens
// `Cell<T, W>` is the type; the underlying preact factories stay internal.
export { cell, type Cell, type ReadonlyCell, type RW } from "./cell";
export { effect, batch, untracked } from "./signal";

// Tween: `Signal.prototype.to` is installed as a side-effect of importing.
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

// Plain `{x, y}` value type. `Vec` (in `values/vec`) is the registered struct.
export type { V } from "../values/vec";

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
  marker,
  palette,
  hover,
  getMarker,
  registerMarker,
  type Marker,
} from "./marker";

export {
  timeline,
  sequential,
  type Clip,
  type Timeline,
  type TimelineOf,
} from "./timeline";
