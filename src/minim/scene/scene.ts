// Callable scene handle: `s(shape)` mounts under root; `s.view(...)`
// or `s.fit(...)` sets the SVG viewBox.

import { aabb, type Box, type Boxlike } from "./box";
import { Box as BoxStruct } from "../signals/aabb";
import { effect, signal } from "../core/signal";
import { toSig, type Arg } from "../core/arg";
import type { AnyShape } from "./shape";

export type Padding =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number };

function resolvePadding(p?: Padding) {
  if (p === undefined || p === 0)
    return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  return {
    top: p.top ?? 0,
    right: p.right ?? 0,
    bottom: p.bottom ?? 0,
    left: p.left ?? 0,
  };
}

export interface Scene {
  <T extends AnyShape>(shape: T): T;
  <T extends AnyShape[]>(...shapes: T): T;

  readonly svg: SVGSVGElement;
  readonly root: AnyShape;

  /** Set viewBox to `(0, 0, w, h)` (reactive in any input). First call
   *  wins; returns a Boxlike representing the viewBox for layout use.
   *  If you ever need a non-zero origin, add a 4-arg overload — none
   *  of the current diagrams do. */
  view(w: Arg<number>, h: Arg<number>): Boxlike;
  /** Auto-fit viewBox to root bounds + optional padding. */
  fit(padding?: Padding): Boxlike;

  /** True until `view()` or `fit()` is called — `Diagram` auto-fits
   *  when `scene()` doesn't set a view explicitly. */
  readonly _viewPending: boolean;
}

export function makeScene(
  svg: SVGSVGElement,
  root: AnyShape,
  host?: HTMLElement,
): Scene {
  let viewSet = false;
  const viewSig = signal<Box>(aabb(0, 0, 0, 0));
  const viewBox = BoxStruct.derived(() => viewSig.value);

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
    // Drive host sizing from viewBox: `:host` reads `--d-w` to set
    // max-width, so author calls `s.view(W, H)` once and the layout
    // follows. Authors can override per-element via `style="--d-w: N"`.
    if (host) {
      host.style.setProperty("--d-w", String(w));
      host.style.setProperty("--d-h", String(h));
    }
  };

  Object.defineProperty(fn, "svg", { value: svg });
  Object.defineProperty(fn, "root", { value: root });
  Object.defineProperty(fn, "_viewPending", { get: () => !viewSet });

  fn.view = (w, h) => {
    if (viewSet) return viewBox;
    const ws = toSig(w);
    const hs = toSig(h);
    effect(() => setViewBox(0, 0, ws.value, hs.value));
    viewSet = true;
    return viewBox;
  };

  fn.fit = (padding) => {
    if (viewSet) return viewBox;
    const p = resolvePadding(padding);
    const b = root.aabb.value;
    setViewBox(
      b.x - p.left,
      b.y - p.top,
      b.w + p.left + p.right,
      b.h + p.top + p.bottom,
    );
    viewSet = true;
    return viewBox;
  };

  return fn;
}
