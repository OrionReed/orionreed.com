import type { Shape } from "./shape";

/**
 * Scene is a callable handle to a `<g>` root group inside an SVG.
 *
 * - `s(myShape)` — adds a shape to the root, returns it.
 * - `s(a, b, c)` — adds several at once, returns the tuple.
 * - `s.view(x, y, w, h)` — set the SVG viewBox.
 * - `s.svg`, `s.root` — escape hatches.
 */
export interface Scene {
  /** Add a single shape; returns it for binding/chaining. */
  <T extends Shape>(shape: T): T;
  /** Add several shapes at once; returns them as a tuple. */
  <T extends Shape[]>(...shapes: T): T;

  readonly svg: SVGSVGElement;
  readonly root: Shape;

  view(x: number, y: number, w: number, h: number): void;
}

export function makeScene(svg: SVGSVGElement, root: Shape): Scene {
  const fn = ((...shapes: Shape[]) => {
    for (const shape of shapes) root.add(shape);
    return shapes.length === 1 ? shapes[0] : shapes;
  }) as Scene;
  Object.assign(fn, {
    svg,
    root,
    view(x: number, y: number, w: number, h: number) {
      svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
    },
  });
  return fn;
}
