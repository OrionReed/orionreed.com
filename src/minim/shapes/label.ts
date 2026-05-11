import { toSig, type Arg, type Vec } from "../core";
import { Shape, aabb, type ShapeOpts, type Pointlike } from "../scene";
import { tokens } from "./tokens";
import { renderContent, flattenText, type Content } from "./text";

export interface LabelOpts extends ShapeOpts {
  size?: Arg<number>;
  /** Bbox point that sits at `at` — `{0, 0}` = top-left, `{0.5, 0.5}`
   *  (default) = center. See `Anchor` for named consts. */
  align?: Vec;
  bold?: boolean;
}

const xAttr = (x: number) => x <= 0.25 ? "start" : x >= 0.75 ? "end" : "middle";
const yAttr = (y: number) =>
  y <= 0.25 ? "hanging" : y >= 0.75 ? "alphabetic" : "central";

export class Label<O extends LabelOpts = LabelOpts> extends Shape<O> {
  constructor(
    readonly at: Pointlike,
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
      // Pivot rotations on `at`, not the bbox center.
      { origin: () => at.value },
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
  at: Pointlike,
  content: Arg<Content>,
  opts?: O,
): Label<O> => new Label<O>(at, content, opts);
