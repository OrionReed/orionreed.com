import { arrange, Diagram, handle, label, type Mount, num, rect, spring, Vec } from "../../minim";

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
      const handleX = w.clamp(MIN_W, Number.POSITIVE_INFINITY).add(card.translate.x);
      const pos = Vec.lens(
        [handleX, card.translate] as const,
        ([hx, t]) => ({ x: hx, y: t.y + h / 2 }),
        p => [p.x],
      );
      return s(handle(pos, { cursor: "ew-resize", r: 5 }));
    });

    // Every width springs back to its rest; `rate: 0` freezes the
    // spring on the handle being dragged, others keep evolving.
    // `project` clamps overshoot at 0 (heavy underdamping would
    // otherwise dip negative on large drags); velocity zeroes on
    // contact so the integrator doesn't fight the wall.
    widths.forEach((w, i) => {
      const dragging = handles[i].dragging;
      this.anim.start(
        spring(w, WIDTHS[i], {
          omega: 7,
          zeta: 0.08,
          precision: 0,
          rate: () => (dragging.value ? 0 : 1),
          project: v => (v < 0 ? 0 : v),
        }),
      );
    });

    s(label(view.bottom.up(14), "drag handles to resize · cards spring back", { size: 10 }));
  }
}
