// Standard library shapes built on `Shape`. Each is a free function
// taking positional geometry args + an optional opts bag for styling.
// Shape gives you transforms, opacity, bounds, anchors, and disposal
// "for free"; these factories just bind the geometry-specific SVG
// attributes.
//
// Every styling slot accepts `Arg<T>` — value, signal, or thunk. So
// `{ stroke: "red" }`, `{ stroke: themeColor }` (signal), and
// `{ stroke: () => active.value ? "red" : "gray" }` all work, and the
// `attr()` machinery wires up effects only when the input is reactive.

import { Shape, type ShapeOpts } from "./shape";
import { effect, type Arg, read, unwrap } from "./signal";
import type { Point } from "./point";
import { bounds, Pivot } from "./bounds";
import { renderContent, flattenText, type Content } from "./text";
import { tokens } from "./tokens";

const NSS = "non-scaling-stroke";

/** Common style opts shared by stroked + filled shapes. Everything
 *  reactively bindable — pass a value, signal, or thunk.
 *
 *  `fill === true` is sugar for "use the stroke color"; otherwise
 *  treat as `Arg<string>`. `undefined` means no fill (`fill="none"`). */
export interface CommonOpts extends ShapeOpts {
  stroke?: Arg<string>;
  strokeWidth?: Arg<number>;
  thin?: boolean;
  dashed?: boolean;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  fill?: Arg<string> | true;
}

function applyOpts(s: Shape, opts: CommonOpts): void {
  s.attr("stroke", opts.stroke ?? tokens.stroke);
  s.attr(
    "stroke-width",
    opts.strokeWidth ?? (opts.thin ? tokens.thinWeight : tokens.weight),
  );
  s.attr("vector-effect", NSS);
  if (opts.cap) s.attr("stroke-linecap", opts.cap);
  if (opts.join) s.attr("stroke-linejoin", opts.join);
  if (opts.dashed) s.attr("stroke-dasharray", "4 3");

  if (opts.fill === undefined) {
    s.attr("fill", "none");
  } else if (opts.fill === true) {
    s.attr("fill", tokens.stroke);
  } else {
    s.attr("fill", opts.fill);
  }
}

// ── group ───────────────────────────────────────────────────────────

/** Empty container shape — bundles children for transform / opacity
 *  inheritance and shared lifecycle. */
export function group(opts: ShapeOpts = {}): Shape {
  return new Shape(undefined, undefined, opts);
}

// ── line ────────────────────────────────────────────────────────────

export interface LineOpts extends CommonOpts {}

export function line(from: Point, to: Point, opts: LineOpts = {}): Shape {
  const s = new Shape(
    "line",
    () => {
      const a = from.value;
      const b = to.value;
      return bounds(
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.abs(b.x - a.x),
        Math.abs(b.y - a.y),
      );
    },
    opts,
  );
  s.attr("x1", from.x);
  s.attr("y1", from.y);
  s.attr("x2", to.x);
  s.attr("y2", to.y);
  s.attr("stroke-linecap", opts.cap ?? "round");
  applyOpts(s, opts);
  return s;
}

// ── rect ────────────────────────────────────────────────────────────

export interface RectOpts extends CommonOpts {
  corner?: Arg<number>;
}

export function rect(
  x: Arg<number>,
  y: Arg<number>,
  w: Arg<number>,
  h: Arg<number>,
  opts: RectOpts = {},
): Shape {
  const s = new Shape(
    "rect",
    () => bounds(unwrap(x), unwrap(y), unwrap(w), unwrap(h)),
    opts,
  );
  s.attr("x", () => unwrap(x));
  s.attr("y", () => unwrap(y));
  s.attr("width", () => unwrap(w));
  s.attr("height", () => unwrap(h));
  s.attr("rx", opts.corner ?? tokens.corner);
  s.attr("ry", opts.corner ?? tokens.corner);
  applyOpts(s, opts);
  return s;
}

// ── circle ──────────────────────────────────────────────────────────

export interface CircleOpts extends CommonOpts {}

export function circle(
  at: Point,
  r: Arg<number>,
  opts: CircleOpts = {},
): Shape {
  const s = new Shape(
    "circle",
    () => {
      const radius = unwrap(r);
      return bounds(at.x() - radius, at.y() - radius, 2 * radius, 2 * radius);
    },
    opts,
  );
  s.attr("cx", at.x);
  s.attr("cy", at.y);
  s.attr("r", () => unwrap(r));
  applyOpts(s, opts);
  return s;
}

// ── label ───────────────────────────────────────────────────────────

export interface LabelOpts extends ShapeOpts {
  size?: Arg<number>;
  /** Where the label's `at` point sits within the label's box, in
   *  normalized 0..1 coords. Pivot.x affects horizontal alignment
   *  (text-anchor); Pivot.y affects vertical (dominant-baseline).
   *  Defaults to `Pivot.CENTER`.
   *
   *  SVG only supports start/middle/end and hanging/central/alphabetic,
   *  so non-corner pivot values snap to the nearest bucket.
   *
   *  Note: this is the label's *anchor pivot* (text alignment), not the
   *  Shape transform pivot (`ShapeOpts.pivot`). */
  anchor?: Pivot;
  bold?: boolean;
}

function pivotXToTextAnchor(x: number): string {
  return x <= 0.25 ? "start" : x >= 0.75 ? "end" : "middle";
}
function pivotYToBaseline(y: number): string {
  return y <= 0.25 ? "hanging" : y >= 0.75 ? "alphabetic" : "central";
}

export function label(
  at: Point,
  content: Arg<Content>,
  opts: LabelOpts = {},
): Shape {
  const contentR = read(content);
  const size = opts.size ?? tokens.fontSize;
  const anchor = opts.anchor ?? Pivot.CENTER;

  const s = new Shape(
    "text",
    () => {
      const text = flattenText(contentR());
      const fs = unwrap(size);
      const w = fs * Math.max(1, text.length) * tokens.charWidth;
      return bounds(at.x() - anchor.x * w, at.y() - anchor.y * fs, w, fs);
    },
    opts,
  );
  s.attr("x", at.x);
  s.attr("y", at.y);
  s.attr("font-family", tokens.font);
  s.attr("font-size", size);
  s.attr("fill", tokens.stroke);
  s.attr("text-anchor", pivotXToTextAnchor(anchor.x));
  s.attr("dominant-baseline", pivotYToBaseline(anchor.y));
  if (opts.bold) s.attr("font-weight", 700);

  s.track(
    effect(() => {
      (s.intrinsic as SVGElement).innerHTML = renderContent(contentR());
    }),
  );

  return s;
}
