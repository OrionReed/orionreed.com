import { derive, type Inner, Num, Signal, signal, type Val, type Vec } from "@minim/signals";

import { Shape, type ShapeOpts } from "./shape";
import { type Content, flattenText, renderContent } from "./text";
import { tokens } from "./tokens";

export interface LabelOpts extends ShapeOpts {
  size?: Val<number>;
  /** Bbox point that sits at `at` — `{0, 0}` = top-left, `{0.5, 0.5}`
   *  (default) = center. See `Anchor` for named consts. */
  align?: Inner<Vec>;
  bold?: boolean;
  /** Text color. Default `tokens.stroke` (i.e. `var(--text-color)`,
   *  flips with dark mode). Accepts a reactive `Val<string>`. */
  fill?: Val<string>;
}

const xAttr = (x: number) => (x <= 0.25 ? "start" : x >= 0.75 ? "end" : "middle");
const yAttr = (y: number) => (y <= 0.25 ? "hanging" : y >= 0.75 ? "alphabetic" : "central");

export class Label<O extends LabelOpts = LabelOpts> extends Shape<O> {
  /** The user-supplied anchor point — the position the label is
   *  attached to (subject to `align`). Distinct from the inherited
   *  Box `center` / `at(u, v)` which describe the bounding box. */
  readonly anchor: Vec;

  constructor(anchor: Vec, content: Val<Content>, opts: O = {} as O) {
    const contentSig: Signal<Content> =
      content instanceof Signal
        ? content
        : typeof content === "function"
          ? derive(content)
          : signal(content as Content);
    const sizeSig = Num.from(opts.size ?? tokens.fontSize);
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
      { origin: anchor },
    );
    this.anchor = anchor;
    this.attr("x", anchor.x);
    this.attr("y", anchor.y);
    this.attr("font-family", tokens.font);
    this.attr("font-size", sizeSig);
    this.attr("fill", opts.fill ?? tokens.stroke);
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
