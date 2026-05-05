// Shared style opts + applier for stroked/filled shapes.

import { unwrap, type Arg } from "../signal";
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
 *  shape's `segments()`. Also sets `stroke-linecap` (default round) so
 *  individual dashes have rounded ends. The cap-extension scales with
 *  the stroke width so visible dash/gap stays consistent across thin
 *  and normal weights — round caps add `stroke-width` to each dash's
 *  visible length, so we shrink the math dash and grow the math gap
 *  by that amount. */
export function setupDashed(s: Shape, opts: CommonOpts, closed: boolean): void {
  if (!opts.dashed) return;
  const cap = opts.cap ?? "round";
  s.attr("stroke-linecap", cap);

  const stroke =
    opts.strokeWidth !== undefined
      ? unwrap(opts.strokeWidth)
      : opts.thin ? tokens.thinWeight : tokens.weight;
  const capExt = cap === "round" ? stroke : 0;

  s.attr("d", () =>
    dashedPath(s.segments(), { closed, capExtension: capExt }),
  );
}
