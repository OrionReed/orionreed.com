// scene-v2: retained-mode scene graph with @preact/signals-core.
//
// Mental model:
//   - Channels are plain `signal(0)` — preact-signals-core directly.
//     Animate via `this.tween(channel, target, ms, ease)`.
//   - 2D points use `Point` for chainable vector + layout ops.
//     `pt(60, 170)` for static, `lerp(a, b, t)` for derived.
//   - Shape is the universal node. Wrapper `<g>` holds transform +
//     opacity; optional intrinsic SVG element + child shapes.
//     "Group" is `new Shape()` with no intrinsic.
//   - Scene mounts the SVG and exposes convenience factories
//     (`s.line`, `s.rect`, `s.group()`, etc.).
//   - SceneElement is the option-B base — subclass overrides
//     `setup(scene)` and builds the graph there. No render() calls.

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  type Signal,
  type ReadonlySignal,
} from "./signal";

export { type Arg, read, unwrap } from "./signal";

export { Point, pt, lerp } from "./point";

export {
  bounds,
  expandBounds,
  unionBounds,
  type Bounds,
  type Vec,
} from "./bounds";

export { Shape, SVG_NS, Pivot } from "./shape";

export {
  line,
  rect,
  circle,
  label,
  group,
  type LineShape,
  type LineOpts,
  type RectOpts,
  type CircleOpts,
  type LabelOpts,
} from "./shapes";

export { makeScene, type Scene } from "./scene";

export {
  Text,
  t,
  type Content,
  type TextPart,
} from "./text";

export { tokens, type Tokens } from "./tokens";

export { Diagram, css } from "./diagram";
export {
  Anim,
  AbortError,
  easeOut,
  easeInOut,
  type Animator,
  type Yieldable,
} from "./anim";

export {
  tween,
  fadeIn,
  fadeOut,
  parallel,
  sequence,
  withDelay,
  lag,
} from "./anims";
