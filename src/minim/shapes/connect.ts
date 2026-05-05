// Cross-cutting connector ops. Compose against the universal interface
// (`shape.boundary`) — no kind dispatch.

import { Shape, SVG_NS } from "../shape";
import { Point } from "../point";
import { computed, toSig, type Arg } from "../signal";
import { tokens } from "../tokens";
import { Line, type LineOpts } from "./line";

const ARROW_ID = "scene-v2-arrow";
const ARROW_W = 10;          // marker width — arrowhead extends this far past line end
const ARROW_GAP_DEFAULT = 4; // standoff between visible line and source/target

/** Draw a line between two shapes (or shape + point). When given a
 *  Shape endpoint, the line meets the shape's analytic boundary. */
export function connect(
  a: Shape | Point,
  b: Shape | Point,
  opts?: LineOpts,
): Line {
  const aP = a instanceof Shape ? a.boundary(b instanceof Shape ? b.bounds.center : b) : a;
  const bP = b instanceof Shape ? b.boundary(a instanceof Shape ? a.bounds.center : a) : b;
  return new Line(aP, bP, opts);
}

export interface ArrowOpts extends LineOpts {
  /** Visible standoff between line and source/target. Treats Point
   *  endpoints as zero-radius shapes (same gap applies). Default 4. */
  gap?: Arg<number>;
}

/** Arrow from `a` to `b`: line with arrowhead at the `b` end. The tip
 *  lands at `b`'s boundary (or at the Point), with `gap` standoff;
 *  the line itself is shortened so the cap doesn't poke past the tip,
 *  and the start gets a small optical compensation for the round cap
 *  reading shorter than its mathematical extent. */
export function arrow(
  a: Shape | Point,
  b: Shape | Point,
  opts: ArrowOpts = {},
): Line {
  const aBase = a instanceof Shape ? a.boundary(b instanceof Shape ? b.bounds.center : b) : a;
  const bBase = b instanceof Shape ? b.boundary(a instanceof Shape ? a.bounds.center : a) : b;

  const gapSig = toSig(opts.gap ?? ARROW_GAP_DEFAULT);
  const dir = bBase.sub(aBase).normalize();

  // From: push start TOWARD target by gap + weight, so the visible
  // (round-cap) edge sits gap-ish past the source perimeter.
  const aP = aBase.add(dir.scale(computed(() => gapSig.value + tokens.weight)));
  // To: pull end BACK toward source by gap + ARROW_W, so the marker
  // tip (which extends ARROW_W past the line end) lands gap-ish before
  // the target perimeter.
  const bP = bBase.sub(dir.scale(computed(() => gapSig.value + ARROW_W)));

  const line = new Line(aP, bP, opts);
  line.attr("marker-end", `url(#${ARROW_ID})`);
  return line;
}

/** Idempotently install the arrow `<marker>` in this SVG's `<defs>`. */
export function ensureArrowMarker(svg: SVGSVGElement): void {
  let defs = svg.querySelector(":scope > defs") as SVGDefsElement | null;
  if (!defs) {
    defs = document.createElementNS(SVG_NS, "defs") as SVGDefsElement;
    svg.insertBefore(defs, svg.firstChild);
  }
  if (defs.querySelector(`#${ARROW_ID}`)) return;

  const marker = document.createElementNS(SVG_NS, "marker");
  marker.id = ARROW_ID;
  marker.setAttribute("markerWidth", "10");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("refX", "0");
  marker.setAttribute("refY", "3.5");
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "userSpaceOnUse");

  // Triangle with rounded vertices (quadratic beziers at corners).
  const r = 0.9;
  const v0 = { x: 0, y: 0 };
  const v1 = { x: 10, y: 3.5 };
  const v2 = { x: 0, y: 7 };
  const corner = (v: typeof v0, prev: typeof v0, next: typeof v0) => {
    const dPrev = Math.hypot(prev.x - v.x, prev.y - v.y);
    const dNext = Math.hypot(next.x - v.x, next.y - v.y);
    return {
      approach: { x: v.x + (r * (prev.x - v.x)) / dPrev, y: v.y + (r * (prev.y - v.y)) / dPrev },
      depart: { x: v.x + (r * (next.x - v.x)) / dNext, y: v.y + (r * (next.y - v.y)) / dNext },
    };
  };
  const c0 = corner(v0, v2, v1);
  const c1 = corner(v1, v0, v2);
  const c2 = corner(v2, v1, v0);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    `M ${c0.depart.x} ${c0.depart.y} L ${c1.approach.x} ${c1.approach.y} Q ${v1.x} ${v1.y} ${c1.depart.x} ${c1.depart.y} L ${c2.approach.x} ${c2.approach.y} Q ${v2.x} ${v2.y} ${c2.depart.x} ${c2.depart.y} L ${c0.approach.x} ${c0.approach.y} Q ${v0.x} ${v0.y} ${c0.depart.x} ${c0.depart.y} Z`,
  );
  path.setAttribute("fill", tokens.stroke);
  marker.appendChild(path);
  defs.appendChild(marker);
}
