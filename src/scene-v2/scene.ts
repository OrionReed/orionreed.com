import { Bounds, aabb, type AABB } from "./bounds";
import { signal } from "./signal";
import type { Shape } from "./shape";

export type Padding =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number };

function resolvePadding(p?: Padding) {
  if (p === undefined || p === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  return { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 };
}

/** Callable handle to a `<g>` root inside an SVG. */
export interface Scene {
  <T extends Shape>(shape: T): T;
  <T extends Shape[]>(...shapes: T): T;

  readonly svg: SVGSVGElement;
  readonly root: Shape;

  /** Set viewBox explicitly. First call wins. Returns reactive Bounds
   *  representing the viewBox — use `.center`, `.split`, etc. for
   *  layout relative to the scene. */
  view(x: number, y: number, w: number, h: number): Bounds;
  /** Auto-fit viewBox to root bounds + optional padding. First call
   *  wins. Returns reactive Bounds for the resulting viewBox. */
  fit(padding?: Padding): Bounds;

  /** Internal: true if neither `view()` nor `fit()` has been called. */
  readonly _viewPending: boolean;
}

export function makeScene(svg: SVGSVGElement, root: Shape): Scene {
  let viewSet = false;
  const viewSig = signal<AABB>(aabb(0, 0, 0, 0));
  const viewBounds = new Bounds(viewSig);

  const fn = ((...shapes: Shape[]) => {
    for (const shape of shapes) root.add(shape);
    return shapes.length === 1 ? shapes[0] : shapes;
  }) as Scene;

  const setViewBox = (x: number, y: number, w: number, h: number) => {
    viewSig.value = aabb(x, y, w, h);
    svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
  };

  Object.defineProperty(fn, "svg", { value: svg });
  Object.defineProperty(fn, "root", { value: root });
  Object.defineProperty(fn, "_viewPending", { get: () => !viewSet });

  fn.view = (x, y, w, h) => {
    if (viewSet) return viewBounds;
    setViewBox(x, y, w, h);
    viewSet = true;
    return viewBounds;
  };

  fn.fit = (padding) => {
    if (viewSet) return viewBounds;
    const p = resolvePadding(padding);
    const b = root.bounds.snap();
    setViewBox(
      b.x - p.left,
      b.y - p.top,
      b.w + p.left + p.right,
      b.h + p.top + p.bottom,
    );
    viewSet = true;
    return viewBounds;
  };

  return fn;
}
