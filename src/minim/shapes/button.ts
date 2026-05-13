// Labelled, clickable region — group + tinted-rect + label, with
// hover/click handlers wired.

import { cell, toSig, type Arg, type Cell } from "@minim/core";
import { type AnyShape } from "@minim/scene";
import { Anchor, vec, type Pointlike } from "@minim/values";
import { tokens } from "./tokens";
import { group } from "./group";
import { rect } from "./rect";
import { label } from "./label";
import type { Content } from "./text";

export interface ButtonOpts {
  width?: number;
  height?: number;
  size?: Arg<number>;
  /** Externally-controlled hover cell — share across shapes if needed. */
  hovered?: Cell<boolean>;
}

/** A clickable, labelled region positioned at `pos` (top-left). The
 *  `hovered` signal (auto-created) tracks pointer state — derive from
 *  it to drive ancillary visuals. */
export function button(
  pos: Pointlike,
  content: Arg<Content>,
  onClick: () => void,
  opts: ButtonOpts = {},
): AnyShape {
  const w = opts.width ?? 80;
  const h = opts.height ?? 26;
  const size = toSig(opts.size ?? 11);
  const hovered = opts.hovered ?? cell(false);

  const g = group({ translate: pos });

  // Hover tint behind the border so outline weight stays constant.
  g.add(
    rect(0, 0, w, h, {
      fill: tokens.stroke,
      opacity: hovered.derive((h) => (h ? 0.08 : 0)),
      stroke: "none",
    }),
  );
  g.add(rect(0, 0, w, h, { thin: true }));
  g.add(label(vec(w / 2, h / 2), content, { size, align: Anchor.Center }));

  g.on("pointerover", () => {
    hovered.value = true;
  });
  g.on("pointerout", () => {
    hovered.value = false;
  });
  g.on("click", onClick);

  g.el.style.cursor = "pointer";
  return g;
}
