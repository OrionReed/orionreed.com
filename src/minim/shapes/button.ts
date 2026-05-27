// Labelled, clickable region — group + tinted-rect + label, with
// hover/click handlers wired.

import {
  Anchor,
  Num,
  type Signal,
  signal,
  type Val,
  Vec,
  vec,
  type Writable,
} from "@minim/signals";
import { group } from "./group";
import { label } from "./label";
import { rect } from "./rect";
import { type AnyShape } from "./shape";
import type { Content } from "./text";
import { tokens } from "./tokens";

export interface ButtonOpts {
  width?: number;
  height?: number;
  size?: Val<number>;
  /** Externally-controlled hover signal — share across shapes if needed. */
  hovered?: Writable<Signal<boolean>>;
}

/** A clickable, labelled region positioned at `pos` (top-left). The
 *  `hovered` signal (auto-created) tracks pointer state — computed from
 *  it to drive ancillary visuals. */
export function button(
  pos: Vec,
  content: Val<Content>,
  onClick: () => void,
  opts: ButtonOpts = {},
): AnyShape {
  const w = opts.width ?? 80;
  const h = opts.height ?? 26;
  const size = Num.from(opts.size ?? 11);
  const hovered = opts.hovered ?? signal(false);

  // Hover tint behind the border so outline weight stays constant.
  const g = group(
    { translate: pos },
    rect(0, 0, w, h, {
      fill: tokens.stroke,
      opacity: () => (hovered.value ? 0.08 : 0),
      stroke: "none",
    }),
    rect(0, 0, w, h, { thin: true }),
    label(vec(w / 2, h / 2), content, { size, align: Anchor.Center }),
  );

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
