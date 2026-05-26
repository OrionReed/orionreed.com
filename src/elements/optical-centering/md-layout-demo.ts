import { arrange, Diagram, handle, label, Mount, num, rect, spring, Vec } from "../../minim";

const WIDTHS = [72, 68, 80, 60, 76];
const HEIGHTS = [52, 44, 60, 48, 56];
const MIN_W = 22;
const GAP = 14;

export class MdLayoutDemo extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 200);
    const cy = view.h.value / 2;

    // `num` (not `signal`) so `spring` can read the `[ALGEBRA]` slot.
    const widths = WIDTHS.map(w => num(w));

    const cards = widths.map((w, i) =>
      s(rect(0, 0, w, HEIGHTS[i], { fill: true, opacity: 0.42, corner: 6 })),
    );

    cards[0].translate.value = { x: 30, y: cy - HEIGHTS[0] / 2 };
    arrange(cards, "row", { gap: GAP, align: 0.5 });

    // Each handle sits at the card's right edge: x = w.clamp(MIN_W,∞)
    // + card.translate.x. The invertible chain absorbs writes back
    // through to the width signal (clamped to MIN_W). The Vec.lens
    // just locks y to the card's vertical centre.
    const handles = widths.map((w, i) => {
      const card = cards[i];
      const h = HEIGHTS[i];
      const handleX = w.clamp(MIN_W, Infinity).add(card.translate.x);
      const pos = Vec.lens(
        () => ({ x: handleX.value, y: card.translate.value.y + h / 2 }),
        p => {
          handleX.value = p.x;
        },
      );
      return s(handle(pos, { cursor: "ew-resize", r: 5 }));
    });

    // Every width springs back to its rest; `rate: 0` freezes the
    // spring on the handle being dragged, others keep evolving.
    widths.forEach((w, i) => {
      const dragging = handles[i].dragging;
      this.anim.start(
        spring(w, WIDTHS[i], {
          omega: 7,
          zeta: 0.08,
          precision: 0,
          rate: () => (dragging.value ? 0 : 1),
        }),
      );
    });

    s(label(view.bottom.up(14), "drag handles to resize · cards spring back", { size: 10 }));
  }
}
