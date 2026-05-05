// SVG `<clipPath>` helper. Builds a clipPath def in the scene's `<defs>`
// using a `<use>` element pointing at the source shape — so the clip
// reactively follows the source's geometry without us cloning attrs.

import { SVG_NS, type Shape } from "../shape";
import type { Scene } from "../scene";

let nextId = 0;

function ensureDefs(svg: SVGSVGElement): SVGDefsElement {
  let defs = svg.querySelector(":scope > defs") as SVGDefsElement | null;
  if (!defs) {
    defs = document.createElementNS(SVG_NS, "defs") as SVGDefsElement;
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}

/** Create a `<clipPath>` matching `shape`'s rendered geometry (via
 *  `<use href>`) and return a `clip-path` URL string suitable for
 *  passing to `attr("clip-path", ...)` or `el.setAttribute`. */
export function clipPath(scene: Scene, shape: Shape): string {
  const target = shape.intrinsic ?? shape.el;
  if (!target.id) target.id = `clip-target-${nextId++}`;
  const id = `clip-${nextId++}`;
  const cp = document.createElementNS(SVG_NS, "clipPath");
  cp.id = id;
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${target.id}`);
  cp.appendChild(use);
  ensureDefs(scene.svg).appendChild(cp);
  return `url(#${id})`;
}
