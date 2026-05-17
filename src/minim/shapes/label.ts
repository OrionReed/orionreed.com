import {toSignal, Vec, type VecValue, type Val} from "@minim/signals";
import {Shape, type ShapeOpts} from "./shape";
import {tokens} from "./tokens";
import {renderContent, flattenText, type Content} from "./text";

export interface LabelOpts extends ShapeOpts {
  size?: Val<number>;
  /** Bbox point that sits at `at` — `{0, 0}` = top-left, `{0.5, 0.5}`
   *  (default) = center. See `Anchor` for named consts. */
  align?: VecValue;
  bold?: boolean;
}

const xAttr = (x: number) => x <= 0.25 ? "start" : x >= 0.75 ? "end" : "middle";
const yAttr = (y: number) =>
  y <= 0.25 ? "hanging" : y >= 0.75 ? "alphabetic" : "central";

export class Label<O extends LabelOpts = LabelOpts> extends Shape<O> {
  /** The user-supplied anchor point — the position the label is
   *  attached to (subject to `align`). Distinct from the inherited
   *  Box `center` / `at(u, v)` which describe the bounding box. */
  readonly anchor: Vec;

  constructor(
    anchor: Vec,
    content: Val<Content>,
    opts: O = {} as O,
  ) {
    const contentSig = toSignal(content);
    const sizeSig = toSignal(opts.size ?? tokens.fontSize);
    const a = opts.align ?? { x: 0.5, y: 0.5 };
    super(
      "text",
      () => {
        const text = flattenText(contentSig.value);
        const fs = sizeSig.value;
        const w = fs * Math.max(1, text.length) * tokens.charWidth;
        return { x: anchor.x.value - a.x * w, y: anchor.y.value - a.y * fs, w, h: fs };
      },
      opts,
      // Pivot rotations on the anchor, not the bbox center.
      { origin: () => anchor.value },
    );
    this.anchor = anchor;
    this.attr("x", anchor.x);
    this.attr("y", anchor.y);
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
  at: Vec,
  content: Val<Content>,
  opts?: O,
): Label<O> => new Label<O>(at, content, opts);
