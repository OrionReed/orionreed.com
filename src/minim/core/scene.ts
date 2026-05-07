// Callable scene handle: `s(shape)` mounts under root, plus
// `s.view(...)` / `s.fit(...)` to set the SVG viewBox.

import { Bounds, aabb, type AABB } from "./bounds";
import { effect, signal } from "./signal";
import { toSig, type Arg } from "./arg";
import type { AnyShape } from "./shape";

export type Padding =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number };

function resolvePadding(p?: Padding) {
  if (p === undefined || p === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  return { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 };
}

export interface Scene {
  <T extends AnyShape>(shape: T): T;
  <T extends AnyShape[]>(...shapes: T): T;

  readonly svg: SVGSVGElement;
  readonly root: AnyShape;

  /** Set viewBox. Reactive in any `Arg<number>` input. First call
   *  wins; returns Bounds representing the viewBox for layout use. */
  view(
    x: Arg<number>,
    y: Arg<number>,
    w: Arg<number>,
    h: Arg<number>,
  ): Bounds;
  /** Auto-fit viewBox to root bounds + optional padding. First call wins. */
  fit(padding?: Padding): Bounds;

  /** True until `view()` or `fit()` is called — `Diagram` falls back
   *  to auto-fit if `setup` doesn't set the view explicitly. */
  readonly _viewPending: boolean;
}

export function makeScene(svg: SVGSVGElement, root: AnyShape): Scene {
  let viewSet = false;
  const viewSig = signal<AABB>(aabb(0, 0, 0, 0));
  const viewBounds = new Bounds(viewSig);

  const fn = ((...shapes: AnyShape[]) => {
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
    const xs = toSig(x);
    const ys = toSig(y);
    const ws = toSig(w);
    const hs = toSig(h);
    effect(() => setViewBox(xs.value, ys.value, ws.value, hs.value));
    viewSet = true;
    return viewBounds;
  };

  fn.fit = (padding) => {
    if (viewSet) return viewBounds;
    const p = resolvePadding(padding);
    const b = root.bounds.value;
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
