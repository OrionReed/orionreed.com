// Standard library shapes built on `Shape`. Each is a free function
// taking positional geometry args + an optional opts bag for styling.
// Shape gives you transforms, opacity, bounds, and disposal "for free";
// these factories just bind the geometry-specific SVG attributes.

import { Shape } from "./shape";
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
  opacity?: Arg<number>;
}

function applyStroke(
  s: Shape,
  opts: CommonStrokeOpts,
  fillable = false,
): void {
  const stroke = opts.stroke ?? tokens.stroke;
  const weight = opts.strokeWidth
    ? () => unwrap(opts.strokeWidth!)
    : () => (opts.thin ? tokens.thinWeight : tokens.weight);

  s.attr("stroke", () => stroke);
  s.attr("stroke-width", weight);
  s.attr("vector-effect", () => NSS);
  if (opts.cap) s.attr("stroke-linecap", () => opts.cap as string);
  if (opts.join) s.attr("stroke-linejoin", () => opts.join as string);
  if (opts.dashed) s.attr("stroke-dasharray", () => "4 3");
  if (!fillable) s.attr("fill", () => "none");

  if (opts.opacity !== undefined) {
    const oFn = read(opts.opacity);
    s.track(
      effect(() => {
        s.opacity.value = oFn();
      }),
    );
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
  const s = new Shape("line") as LineShape;
  s.attr("x1", from.x);
  s.attr("y1", from.y);
  s.attr("x2", to.x);
  s.attr("y2", to.y);
  if (!opts.cap) s.attr("stroke-linecap", () => "round");
  applyStroke(s, opts);

  s.setBounds(() => {
    const a = from.value;
    const b = to.value;
    return bounds(
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.abs(b.x - a.x),
      Math.abs(b.y - a.y),
    );
  });

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
  const s = new Shape("rect");
  s.attr("x", () => unwrap(x));
  s.attr("y", () => unwrap(y));
  s.attr("width", () => unwrap(w));
  s.attr("height", () => unwrap(h));
  const corner = opts.corner ?? tokens.corner;
  s.attr("rx", () => unwrap(corner));
  s.attr("ry", () => unwrap(corner));

  const filled = opts.fill !== undefined;
  applyStroke(s, opts, filled);
  if (filled) {
    const fill = opts.fill === true ? tokens.stroke : opts.fill!;
    s.attr("fill", () => fill);
  }

  s.setBounds(() => bounds(unwrap(x), unwrap(y), unwrap(w), unwrap(h)));
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
  const s = new Shape("circle");
  s.attr("cx", at.x);
  s.attr("cy", at.y);
  s.attr("r", () => unwrap(r));

  const filled = opts.fill !== undefined;
  applyStroke(s, opts, filled);
  if (filled) {
    const fill = opts.fill === true ? tokens.stroke : opts.fill!;
    s.attr("fill", () => fill);
  }

  s.setBounds(() => {
    const radius = unwrap(r);
    return bounds(at.x() - radius, at.y() - radius, 2 * radius, 2 * radius);
  });
  return s;
}

// ── label ───────────────────────────────────────────────────────────

export interface LabelOpts {
  size?: Arg<number>;
  anchor?: "start" | "middle" | "end";
  baseline?: "top" | "middle" | "bottom";
  bold?: boolean;
  opacity?: Arg<number>;
}

const baselineMap = {
  top: "hanging",
  middle: "central",
  bottom: "alphabetic",
} as const;

export function label(
  at: Point,
  content: Arg<Content>,
  opts: LabelOpts = {},
): Shape {
  const contentR = read(content);
  const size = opts.size ?? tokens.fontSize;

  const s = new Shape("text");
  s.attr("x", at.x);
  s.attr("y", at.y);
  s.attr("font-family", () => tokens.font);
  s.attr("font-size", () => unwrap(size));
  s.attr("fill", () => tokens.stroke);
  s.attr("text-anchor", () => opts.anchor ?? "middle");
  s.attr(
    "dominant-baseline",
    () => baselineMap[opts.baseline ?? "middle"],
  );
  if (opts.bold) s.attr("font-weight", () => 700);

  s.track(
    effect(() => {
      (s.intrinsic as SVGElement).innerHTML = renderContent(contentR());
    }),
  );

  if (opts.opacity !== undefined) {
    const oFn = read(opts.opacity);
    s.track(
      effect(() => {
        s.opacity.value = oFn();
      }),
    );
  }

  s.setBounds(() => {
    const text = flattenText(contentR());
    const fs = unwrap(size);
    const w = fs * Math.max(1, text.length) * tokens.charWidth;
    return bounds(at.x() - w / 2, at.y() - fs / 2, w, fs);
  });

  return s;
}
