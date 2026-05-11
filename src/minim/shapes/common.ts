// Shared style options + applier for stroked/filled shapes.

import { computed, toSig, type Arg } from "../core";
import type { AnyShape, ShapeOpts } from "../scene";
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
    computed(() => dashedPath(s.segments(), { closed, capExtension: capExt })),
  );
}
