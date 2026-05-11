// SVG-native button: a labelled, clickable region with a subtle hover
// affordance. Composes group + rect + label, exposes a `hovered`
// signal for callers that want to drive their own styling, and wires
// `pointerover` / `pointerout` / `click` for free.
//
// Lives in `shapes/` rather than `scene/interaction.ts` because it
// composes higher-level shape primitives. Pairs naturally with
// `draggable` (the lower-level interactivity bridge).

import { signal, toSig, type Arg, type Signal } from "../core";
import { type AnyShape, type Pointlike, pt } from "../scene";
import { tokens } from "./tokens";
import { group } from "./group";
import { rect } from "./rect";
import { label } from "./label";
import { align } from "./layout";
import type { Content } from "./text";

export interface ButtonOpts {
  /** Pixel width of the button rectangle. Default 80. */
  width?: number;
  /** Pixel height of the button rectangle. Default 26. */
  height?: number;
  /** Font size for the label. Default 11. */
  size?: Arg<number>;
  /** Externally-controlled hovered signal — useful for synchronising
   *  hover state across multiple shapes. Defaults to a fresh internal
   *  signal driven by `pointerover` / `pointerout` on the group. */
  hovered?: Signal<boolean>;
}

/** A clickable, labelled region. The returned shape is a `group`
 *  positioned at `pos` (top-left); compose it like any other shape:
 *
 *      const stop = s(button(pt(20, 20), "STOP", () => dispose()));
 *
 *  The `hovered` signal (auto-created if not provided) tracks pointer
 *  state — read it in derived signals to drive ancillary visuals. */
export function button(
  pos: Pointlike,
  content: Arg<Content>,
  onClick: () => void,
  opts: ButtonOpts = {},
): AnyShape {
  const w = opts.width ?? 80;
  const h = opts.height ?? 26;
  const size = toSig(opts.size ?? 11);
  const hovered = opts.hovered ?? signal(false);

  const g = group({ translate: pos });

  // Hover tint — a faint fill of the text colour. Sits behind the
  // border so the outline stays the same weight throughout.
  g.add(
    rect(0, 0, w, h, {
      fill: tokens.stroke,
      opacity: hovered.derive((h) => (h ? 0.08 : 0)),
      stroke: "none",
    }),
  );
  // Outlined border.
  g.add(rect(0, 0, w, h, { thin: true }));
  // Centred label.
  g.add(label(pt(w / 2, h / 2), content, { size, align: align.center }));

  g.on("pointerover", () => {
    hovered.value = true;
  });
  g.on("pointerout", () => {
    hovered.value = false;
  });
  g.on("click", onClick);

  // Affordance: pointer cursor over the whole region, including the
  // text (set on the group's element so it covers all children).
  g.el.style.cursor = "pointer";

  return g;
}
