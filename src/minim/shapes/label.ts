import { Shape, type ShapeOpts } from "../shape";
import { aabb, type Vec } from "../bounds";
import { toSig, type Arg } from "../signal";
import { tokens } from "../tokens";
import { renderContent, flattenText, type Content } from "../text";
import type { Point } from "../point";

export interface LabelOpts extends ShapeOpts {
  size?: Arg<number>;
  /** Where on the label's own bbox sits at the `at` point. Normalized
   *  Vec: `{x: 0, y: 0}` puts the label's top-left at `at`,
   *  `{x: 0.5, y: 0.5}` (default) puts its center there. The `align`
   *  namespace in `layout.ts` provides named consts for common cases. */
  align?: Vec;
  bold?: boolean;
}

const xAttr = (x: number) => x <= 0.25 ? "start" : x >= 0.75 ? "end" : "middle";
const yAttr = (y: number) =>
  y <= 0.25 ? "hanging" : y >= 0.75 ? "alphabetic" : "central";

export class Label<O extends LabelOpts = LabelOpts> extends Shape<O> {
  constructor(
    readonly at: Point,
    content: Arg<Content>,
    opts: O = {} as O,
  ) {
    const contentSig = toSig(content);
    const sizeSig = toSig(opts.size ?? tokens.fontSize);
    const a = opts.align ?? { x: 0.5, y: 0.5 };
    super(
      "text",
      () => {
        const text = flattenText(contentSig.value);
        const fs = sizeSig.value;
        const w = fs * Math.max(1, text.length) * tokens.charWidth;
        return aabb(at.x.value - a.x * w, at.y.value - a.y * fs, w, fs);
      },
      opts,
      {
        // Default origin: the `at` point — rotations pivot around the
        // anchor, not the bbox center, so a rotated label hinges on
        // where it was placed.
        origin: () => at.value,
      },
    );
    this.attr("x", at.x);
    this.attr("y", at.y);
    this.attr("font-family", tokens.font);
    this.attr("font-size", sizeSig);
    this.attr("fill", tokens.stroke);
    this.attr("text-anchor", xAttr(a.x));
    this.attr("dominant-baseline", yAttr(a.y));
    if (opts.bold) this.attr("font-weight", 700);

    this.effect(() => {
      (this.intrinsic as SVGElement).innerHTML = renderContent(contentSig.value);
    });
  }
}

export const label = <const O extends LabelOpts>(
  at: Point,
  content: Arg<Content>,
  opts?: O,
): Label<O> => new Label<O>(at, content, opts);
