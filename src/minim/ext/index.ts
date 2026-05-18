// Extras — opt-in extensions that don't need to be in `core/`. Each
// module is independently useful and self-contained:
//
//   timeline   declarative clip composition over a clock
//   events     named-event bus with `until(name)` suspension
//   waapi      Web Animations / scroll / view-timeline bridges
//   snapshot   capture-and-restore for cells (loop bodies, cancels)

export {
  timeline,
  sequential,
  type Clip,
  type Timeline,
  type TimelineOf,
} from "./timeline";

export { EventBus } from "./events";

export { snapshot } from "./snapshot";

export {
  native,
  untilAnimation,
  untilInView,
  untilOutOfView,
  scrollProgress,
  viewProgress,
  inView,
  type ViewRange,
} from "./waapi";
