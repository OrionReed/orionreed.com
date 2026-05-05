import { Shape, type ShapeOpts } from "../shape";
import { Pivot, aabb } from "../bounds";
import { read, unwrap, type Arg } from "../signal";
import { tokens } from "../tokens";
import { renderContent, flattenText, type Content } from "../text";
import type { Point } from "../point";

export interface LabelOpts extends ShapeOpts {
  size?: Arg<number>;
  /** Where the `at` point sits within the label box (text alignment).
   *  SVG buckets: x→start/middle/end, y→hanging/central/alphabetic. */
  anchor?: Pivot;
  bold?: boolean;
}

const xAttr = (x: number) => x <= 0.25 ? "start" : x >= 0.75 ? "end" : "middle";
const yAttr = (y: number) =>
  y <= 0.25 ? "hanging" : y >= 0.75 ? "alphabetic" : "central";

export class Label extends Shape {
  constructor(
    readonly at: Point,
    content: Arg<Content>,
    opts: LabelOpts = {},
  ) {
    const contentR = read(content);
    const size = opts.size ?? tokens.fontSize;
    const a = opts.anchor ?? Pivot.CENTER;
    super(
      "text",
      () => {
        const text = flattenText(contentR());
        const fs = unwrap(size);
        const w = fs * Math.max(1, text.length) * tokens.charWidth;
        return aabb(at.x() - a.x * w, at.y() - a.y * fs, w, fs);
      },
      // Default rotation pivot to the anchor — so rotating a label
      // pivots around its `at` point, not the bounds center. User can
      // still override via opts.pivot.
      { pivot: a, ...opts },
    );
    this.attr("x", at.x);
    this.attr("y", at.y);
    this.attr("font-family", tokens.font);
    this.attr("font-size", size);
    this.attr("fill", tokens.stroke);
    this.attr("text-anchor", xAttr(a.x));
    this.attr("dominant-baseline", yAttr(a.y));
    if (opts.bold) this.attr("font-weight", 700);

    this.effect(() => {
      (this.intrinsic as SVGElement).innerHTML = renderContent(contentR());
    });
  }
}

export const label = (at: Point, content: Arg<Content>, opts?: LabelOpts) =>
  new Label(at, content, opts);
