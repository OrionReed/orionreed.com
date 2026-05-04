// Standard library shapes built on `Shape`. Each is a free function
// taking positional geometry args + an optional opts bag for styling.
// Shape gives you transforms, opacity, bounds, anchors, and disposal
// "for free"; these factories just bind the geometry-specific SVG
// attributes.

import { Pivot, Shape } from "./shape";
import { effect, type Arg, read, unwrap } from "./signal";
import type { Point } from "./point";
import { bounds } from "./bounds";
import { renderContent, flattenText, type Content } from "./text";
import { tokens } from "./tokens";

const NSS = "non-scaling-stroke";

interface CommonStrokeOpts {
  stroke?: string;
  strokeWidth?: Arg<number>;
  thin?: boolean;
  dashed?: boolean;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  /** Initial opacity (set once). For reactive opacity that tracks other
   *  signals, use `shape.bindOpacity(fn)` after construction; for
   *  animation, use `fadeIn`/`fadeOut`/`tween(shape.opacity, ...)`. */
  opacity?: number;
}

function applyStroke(
  s: Shape,
  opts: CommonStrokeOpts,
  fillable = false,
): void {
  // Stroke color and weight: stroke is always static today; weight may
  // be reactive via `opts.strokeWidth`.
  s.attr("stroke", opts.stroke ?? tokens.stroke);
  if (opts.strokeWidth !== undefined) {
    s.attr("stroke-width", () => unwrap(opts.strokeWidth!));
  } else {
    s.attr("stroke-width", opts.thin ? tokens.thinWeight : tokens.weight);
  }
  s.attr("vector-effect", NSS);
  if (opts.cap) s.attr("stroke-linecap", opts.cap);
  if (opts.join) s.attr("stroke-linejoin", opts.join);
  if (opts.dashed) s.attr("stroke-dasharray", "4 3");
  if (!fillable) s.attr("fill", "none");

  if (opts.opacity !== undefined) {
    s.opacity.value = opts.opacity;
  }
}

// ── group ───────────────────────────────────────────────────────────

/** Empty container shape — bundles children for transform / opacity
 *  inheritance and shared lifecycle. */
export function group(): Shape {
  return new Shape();
}

// ── line ────────────────────────────────────────────────────────────

export interface LineOpts extends CommonStrokeOpts {}

export interface LineShape extends Shape {
  /** Reactive endpoints — exposed for relative positioning. */
  readonly from: Point;
  readonly to: Point;
}

export function line(from: Point, to: Point, opts: LineOpts = {}): LineShape {
  const s = new Shape("line", () => {
    const a = from.value;
    const b = to.value;
    return bounds(
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.abs(b.x - a.x),
      Math.abs(b.y - a.y),
    );
  }) as LineShape;
  s.attr("x1", from.x);
  s.attr("y1", from.y);
  s.attr("x2", to.x);
  s.attr("y2", to.y);
  s.attr("stroke-linecap", opts.cap ?? "round");
  applyStroke(s, opts);
  Object.defineProperty(s, "from", { value: from });
  Object.defineProperty(s, "to", { value: to });
  return s;
}

// ── rect ────────────────────────────────────────────────────────────

export interface RectOpts extends CommonStrokeOpts {
  corner?: Arg<number>;
  /** `true` → fill with stroke color; string → that color; else no fill. */
  fill?: string | true;
}

export function rect(
  x: Arg<number>,
  y: Arg<number>,
  w: Arg<number>,
  h: Arg<number>,
  opts: RectOpts = {},
): Shape {
  const s = new Shape("rect", () =>
    bounds(unwrap(x), unwrap(y), unwrap(w), unwrap(h)),
  );
  s.attr("x", () => unwrap(x));
  s.attr("y", () => unwrap(y));
  s.attr("width", () => unwrap(w));
  s.attr("height", () => unwrap(h));
  if (opts.corner !== undefined) {
    s.attr("rx", () => unwrap(opts.corner!));
    s.attr("ry", () => unwrap(opts.corner!));
  } else {
    s.attr("rx", tokens.corner);
    s.attr("ry", tokens.corner);
  }

  const filled = opts.fill !== undefined;
  applyStroke(s, opts, filled);
  if (filled) {
    s.attr("fill", opts.fill === true ? tokens.stroke : opts.fill!);
  }
  return s;
}

// ── circle ──────────────────────────────────────────────────────────

export interface CircleOpts extends CommonStrokeOpts {
  fill?: string | true;
}

export function circle(
  at: Point,
  r: Arg<number>,
  opts: CircleOpts = {},
): Shape {
  const s = new Shape("circle", () => {
    const radius = unwrap(r);
    return bounds(at.x() - radius, at.y() - radius, 2 * radius, 2 * radius);
  });
  s.attr("cx", at.x);
  s.attr("cy", at.y);
  s.attr("r", () => unwrap(r));

  const filled = opts.fill !== undefined;
  applyStroke(s, opts, filled);
  if (filled) {
    s.attr("fill", opts.fill === true ? tokens.stroke : opts.fill!);
  }
  return s;
}

// ── label ───────────────────────────────────────────────────────────

export interface LabelOpts {
  size?: Arg<number>;
  /** Where the label's `at` point sits within the label's box, in
   *  normalized 0..1 coords. Pivot.x affects horizontal alignment
   *  (text-anchor); Pivot.y affects vertical (dominant-baseline).
   *  Defaults to `Pivot.CENTER`.
   *
   *  SVG only supports start/middle/end and hanging/central/alphabetic,
   *  so non-corner pivot values snap to the nearest bucket. */
  pivot?: Pivot;
  bold?: boolean;
  /** Initial opacity; see CommonStrokeOpts.opacity for animation notes. */
  opacity?: number;
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
  const pivot = opts.pivot ?? Pivot.CENTER;

  const s = new Shape("text", () => {
    const text = flattenText(contentR());
    const fs = unwrap(size);
    const w = fs * Math.max(1, text.length) * tokens.charWidth;
    return bounds(at.x() - pivot.x * w, at.y() - pivot.y * fs, w, fs);
  });
  s.attr("x", at.x);
  s.attr("y", at.y);
  s.attr("font-family", tokens.font);
  s.attr("font-size", () => unwrap(size));
  s.attr("fill", tokens.stroke);
  s.attr("text-anchor", pivotXToTextAnchor(pivot.x));
  s.attr("dominant-baseline", pivotYToBaseline(pivot.y));
  if (opts.bold) s.attr("font-weight", 700);

  // Reactive content: re-renders the inner tspan tree when content changes.
  // For static content this runs once.
  s.track(
    effect(() => {
      (s.intrinsic as SVGElement).innerHTML = renderContent(contentR());
    }),
  );

  if (opts.opacity !== undefined) {
    s.opacity.value = opts.opacity;
  }

  return s;
}
