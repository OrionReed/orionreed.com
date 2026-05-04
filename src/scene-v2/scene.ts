import { Shape } from "./shape";
import {
  line,
  rect,
  circle,
  label,
  type CircleOpts,
  type LabelOpts,
  type LineOpts,
  type LineShape,
  type RectOpts,
} from "./shapes";
import type { Arg } from "./signal";
import type { RPoint } from "./rval";
import type { Content } from "./text";

/**
 * Scene = an SVG root + a `Shape` root group. Provides convenience
 * factory methods that build a shape and add it to the root in one
 * step (`s.line(a, b)` rather than `root.add(line(a, b))`).
 *
 * Custom shapes are added via `s.add(myShape)`. Empty groups (for
 * bundling children for unified opacity / lifecycle) via `s.group()`.
 */
export class Scene {
  constructor(
    public readonly svg: SVGSVGElement,
    public readonly root: Shape,
  ) {}

  /** Set the SVG viewBox + explicit width/height. */
  view(x: number, y: number, w: number, h: number): void {
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
  }

  /** Add a custom shape to the root. */
  add<T extends Shape>(shape: T): T {
    return this.root.add(shape);
  }

  /** Create an empty container shape, added to the root. */
  group(): Shape {
    return this.add(new Shape());
  }

  // Convenience factories — build + add in one call.

  line(from: RPoint, to: RPoint, opts?: LineOpts): LineShape {
    return this.add(line(from, to, opts));
  }

  rect(
    x: Arg<number>,
    y: Arg<number>,
    w: Arg<number>,
    h: Arg<number>,
    opts?: RectOpts,
  ): Shape {
    return this.add(rect(x, y, w, h, opts));
  }

  circle(at: RPoint, r: Arg<number>, opts?: CircleOpts): Shape {
    return this.add(circle(at, r, opts));
  }

  label(at: RPoint, content: Arg<Content>, opts?: LabelOpts): Shape {
    return this.add(label(at, content, opts));
  }
}
