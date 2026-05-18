// `arrange` reflows reactively as handles resize cards.
// The highlighted card has a spring on its width: drag it wider and
// it snaps back when released — handle + spring composing on one signal.

import {Diagram, Mount, Anchor, Vec, derived, arrange, handle, label, num, play, rect, spring} from "../../minim";

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

    // `num(w)` (vs `signal(w)`) so `spring(...)` can read the `[ALGEBRA]`
    // slot — plain Signal<number> has no algebra installed.
    const widths = WIDTHS.map((w) => num(w));
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

    // Right-edge resize handle for every card. The SPRING_IDX handle's
    // `.dragging` signal gates the spring below via `at(reactive)` —
    // `at(0)` freezes the spring while the user drags, `at(1)` resumes.
    const handles = widths.map((w, i) => {
      const card = cards[i];
      const h = HEIGHTS[i];
      const pos = derived(Vec,
        () => ({
          x: card.translate.value.x + w.value,
          y: card.translate.value.y + h / 2,
        }),
        (p) => {
          w.value = Math.max(MIN_W, p.x - card.translate.value.x);
        },
      );
      return s(handle(pos, { cursor: "ew-resize", r: 5 }));
    });

    // Spring pulls the highlighted card's width back to rest. While
    // dragging, `at(0)` freezes it; on release, `at(1)` resumes from
    // the dragged value. One running spring, no restart cycles.
    const dragging = handles[SPRING_IDX].dragging;
    this.anim.start(function* () {
      yield* play(spring(widths[SPRING_IDX], SPRING_REST, { stiffness: 220, damping: 16 }))
        .at(() => dragging.value ? 0 : 1);
    });

    s(
      label(view.bottom.up(14), "drag handles to resize · red card springs back", {
        size: 10,
        align: Anchor.Center,
        opacity: 0.55,
      }),
    );
  }
}
