// scene-v2: retained-mode scene graph with @preact/signals-core.
//
// Mental model:
//   - Channels are plain `signal(0)` — preact-signals-core directly.
//     Animate via `this.tween(channel, target, ms, ease)`.
//   - 2D points use `RPoint` for chainable vector + layout ops.
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

export { RPoint, pt, lerp } from "./rval";

export { Shape, SVG_NS, type Pivot, type PivotKey } from "./shape";

export {
  line,
  rect,
  circle,
  label,
  type LineShape,
  type LineOpts,
  type RectOpts,
  type CircleOpts,
  type LabelOpts,
} from "./shapes";

export { Scene } from "./scene";

export {
  Text,
  t,
  math,
  type Content,
  type TextPart,
} from "./text";

export { SceneElement } from "./scene-element";

export { fadeIn, fadeOut, parallel } from "./anims";
