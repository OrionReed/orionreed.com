// `<clipPath>` matching a shape's geometry via `<use href>` — clip
// follows the source reactively without copying attributes.

import { SVG_NS, type Shape, type Scene } from "../core";

let nextId = 0;

function ensureDefs(svg: SVGSVGElement): SVGDefsElement {
  let defs = svg.querySelector(":scope > defs") as SVGDefsElement | null;
  if (!defs) {
    defs = document.createElementNS(SVG_NS, "defs") as SVGDefsElement;
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}

/** Create a `<clipPath>` mirroring `shape` and return a `url(#id)`
 *  string for use with `clip-path`. */
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
