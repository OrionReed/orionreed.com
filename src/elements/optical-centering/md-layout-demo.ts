import { arrange, Diagram, handle, label, Mount, num, rect, spring, Vec } from "../../minim";

const WIDTHS = [72, 68, 80, 60, 76];
const HEIGHTS = [52, 44, 60, 48, 56];
const SPRING_IDX = 2;
const SPRING_REST = 80;
const MIN_W = 22;
const GAP = 14;

export class MdLayoutDemo extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 200);
    const cy = view.h.value / 2;

    // `num` (not `signal`) so `spring` can read the `[ALGEBRA]` slot.
    const widths = WIDTHS.map(w => num(w));
    widths[SPRING_IDX].value = SPRING_REST;

    const cards = widths.map((w, i) =>
      s(
        rect(0, 0, w, HEIGHTS[i], {
          fill: i === SPRING_IDX ? "#e25c5c" : true,
          opacity: i === SPRING_IDX ? 0.55 : 0.38,
          corner: 6,
        }),
      ),
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

    // `rate: 0` freezes the spring while dragging; `rate: 1` resumes on release.
    const dragging = handles[SPRING_IDX].dragging;
    this.anim.start(
      spring(widths[SPRING_IDX], SPRING_REST, {
        omega: 15,
        zeta: 0.4,
        precision: 0,
        rate: () => (dragging.value ? 0 : 1),
      }),
    );

    s(label(view.bottom.up(14), "drag handles to resize · red card springs back", { size: 10 }));
  }
}
