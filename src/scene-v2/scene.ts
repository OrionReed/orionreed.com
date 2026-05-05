import type { Shape } from "./shape";

/** Callable handle to a `<g>` root inside an SVG. */
export interface Scene {
  <T extends Shape>(shape: T): T;
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
