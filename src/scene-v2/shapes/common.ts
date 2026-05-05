// Shared style opts + applier for stroked/filled shapes.

import type { Arg } from "../signal";
import type { Shape, ShapeOpts } from "../shape";
import { tokens } from "../tokens";
import { dashedPath } from "../dashed";

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

/** Apply stroke + fill + linecap/join. Does NOT handle dashing —
 *  shapes that support `dashed: true` use `setupDashed()` to bind a
 *  reactive `<path>` `d` from their `segments()`. */
export function applyOpts(s: Shape, opts: CommonOpts): void {
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

/** Wire `dashed: true` to a reactive `<path>` `d` computed from the
 *  shape's `segments()`. Caller passes whether the path forms a closed
 *  loop (so the dasher can wrap-around without leaving an end gap).
 *  Shapes that opt in must use `<path>` as their intrinsic when dashed. */
export function setupDashed(s: Shape, opts: CommonOpts, closed: boolean): void {
  if (!opts.dashed) return;
  // Round caps optically extend by ~stroke-width/2, but read shorter than
  // the math says. Approximate with a small constant bump.
  const capExt = opts.cap === "round" ? 1 : 0;
  s.attr("d", () =>
    dashedPath(s.segments(), { closed, capExtension: capExt }),
  );
}
