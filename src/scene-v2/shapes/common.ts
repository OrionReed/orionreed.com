// Shared style opts + applier for stroked/filled shapes.

import type { Arg } from "../signal";
import type { Shape, ShapeOpts } from "../shape";
import { tokens } from "../tokens";

const NSS = "non-scaling-stroke";

/** `fill === true` → stroke color; `Arg<string>` → that color;
 *  `undefined` (default) → no fill. */
export interface CommonOpts extends ShapeOpts {
  stroke?: Arg<string>;
  strokeWidth?: Arg<number>;
  thin?: boolean;
  dashed?: boolean;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  fill?: Arg<string> | true;
}

export function applyOpts(s: Shape, opts: CommonOpts): void {
  s.attr("stroke", opts.stroke ?? tokens.stroke);
  s.attr(
    "stroke-width",
    opts.strokeWidth ?? (opts.thin ? tokens.thinWeight : tokens.weight),
  );
  s.attr("vector-effect", NSS);
  if (opts.cap) s.attr("stroke-linecap", opts.cap);
  if (opts.join) s.attr("stroke-linejoin", opts.join);
  if (opts.dashed) s.attr("stroke-dasharray", "4 3");

  if (opts.fill === undefined) s.attr("fill", "none");
  else if (opts.fill === true) s.attr("fill", tokens.stroke);
  else s.attr("fill", opts.fill);
}
