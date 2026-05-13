// Shared style options + applier for stroked/filled shapes.

import { cell, toSig, type Arg } from "@minim/core";
import type { AnyShape, ShapeOpts } from "@minim/scene";
import { tokens } from "./tokens";
import { dashedPath } from "./dashed";

const NSS = "non-scaling-stroke";

/** `fill: true` → stroke color; string → that color; omitted → no fill. */
export interface CommonOpts extends ShapeOpts {
  stroke?: Arg<string>;
  strokeWidth?: Arg<number>;
  thin?: boolean;
  dashed?: boolean;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  fill?: Arg<string> | true;
}

/** SVG element name for the intrinsic — `"path"` if dashed (so we can
 *  emit explicit segment runs), else `nativeKind`. Pass to `super(...)`. */
export function intrinsicType(opts: CommonOpts, nativeKind: string): string {
  return opts.dashed ? "path" : nativeKind;
}

/** One-call wire-up for stroke shapes. Call after `super(...)` with a
 *  callback that writes the shape's native attributes (`cx/cy/r` for
 *  circle, `x1/y1/x2/y2` for line, etc.); the callback runs only when
 *  not dashed. Then sets up the dashed `<path d>` (if dashed) and
 *  applies common stroke/fill options. */
export function wireStroke<S extends AnyShape>(
  s: S,
  opts: CommonOpts,
  closed: boolean,
  nativeAttrs?: () => void,
): void {
  if (!opts.dashed && nativeAttrs) nativeAttrs();
  setupDashed(s, opts, closed);
  applyOpts(s, opts);
}

/** Apply stroke + fill + linecap/join. Dashing is `setupDashed`. */
export function applyOpts<S extends AnyShape>(s: S, opts: CommonOpts): void {
  s.attr("stroke", opts.stroke ?? tokens.stroke);
  s.attr(
    "stroke-width",
    opts.strokeWidth ?? (opts.thin ? tokens.thinWeight : tokens.weight),
  );
  s.attr("vector-effect", NSS);
  if (opts.cap) s.attr("stroke-linecap", opts.cap);
  if (opts.join) s.attr("stroke-linejoin", opts.join);

  if (opts.fill === undefined) s.attr("fill", "none");
  else if (opts.fill === true) s.attr("fill", tokens.stroke);
  else s.attr("fill", opts.fill);
}

/** When `dashed`, bind a reactive `<path>` `d` from `s.segments()`.
 *  `capExtension` compensates for round caps so the visible dash/gap
 *  ratio stays consistent across stroke weights. */
export function setupDashed<S extends AnyShape>(
  s: S,
  opts: CommonOpts,
  closed: boolean,
): void {
  if (!opts.dashed) return;
  const cap = opts.cap ?? "round";
  s.attr("stroke-linecap", cap);

  const stroke =
    opts.strokeWidth === undefined
      ? (opts.thin ? tokens.thinWeight : tokens.weight)
      : toSig(opts.strokeWidth).value;
  const capExt = cap === "round" ? stroke : 0;

  s.attr(
    "d",
    cell.derived(() => dashedPath(s.segments(), { closed, capExtension: capExt })),
  );
}
