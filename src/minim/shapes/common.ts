// Shared style opts + applier for stroked/filled shapes.

import { computed, toSig, type Arg } from "../signal";
import type { AnyShape, ShapeOpts } from "../shape";
import { tokens } from "../tokens";
import { dashedPath } from "../dashed";

const NSS = "non-scaling-stroke";

/** `fill: true` → stroke color; `Arg<string>` → that color;
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

/** Apply stroke + fill + linecap/join. Dashing is handled separately
 *  by `setupDashed`. */
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

/** Bind a reactive `<path>` `d` from `s.segments()` when `dashed`
 *  is set. `capExtension` scales with stroke width so the visible
 *  dash/gap ratio stays consistent across weights. */
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
    computed(() => dashedPath(s.segments(), { closed, capExtension: capExt })),
  );
}
