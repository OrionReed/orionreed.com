// Showcases the layout primitives:
//   - `align` namespace for label alignment.
//   - `bounds.at(u, v)` for arbitrary anchor points.
//   - `arrange(shapes, axis, opts)` for reactive row/column layout.
//   - Width animation flowing through `arrange` to reflow neighbours.

import {
  Diagram,
  Scene,
  align,
  arrange,
  circle,
  computed,
  css,
  easeInOut,
  label,
  pt,
  rect,
  signal,
  t,
} from "../../minim";

export class MdLayoutDemo extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 560px;
    }
  `;

  protected setup(s: Scene): void {
    s.view(0, 0, 520, 280);

    // ── Top: a rect with labels at each of the 9 align positions ──────
    const card = s(rect(20, 20, 280, 130, { thin: true, opacity: 0.5 }));
    const cells: Array<[number, number, string]> = [
      [0,   0,   "TL"], [0.5, 0,   "T"],  [1,   0,   "TR"],
      [0,   0.5, "L"],  [0.5, 0.5, "C"],  [1,   0.5, "R"],
      [0,   1,   "BL"], [0.5, 1,   "B"],  [1,   1,   "BR"],
    ];
    for (const [u, v, name] of cells) {
      s(circle(card.bounds.at(u, v), 2, { fill: true, opacity: 0.7 }));
      s(label(card.bounds.at(u, v), name, {
        size: 12,
        // Mirror the anchor: TL anchor → align.bottomRight pulls the
        // label inside the box; centers stay centered.
        align: { x: 1 - u, y: 1 - v },
        opacity: 0.7,
      }));
    }

    // Caption — placed via the `align` namespace.
    s(label(card.bounds.at(0.5, 0).up(8), t("bounds.at(u, v) + align").muted(), {
      size: 11,
      align: align.bottom,
    }));

    // ── Bottom: a row of rects of different widths arranged reactively ─
    // The first rect's width is animated; arrange() reflows the rest.
    const w0 = signal(40);
    const widths = [w0, signal(56), signal(36), signal(64), signal(48)];
    const heights = [40, 30, 50, 35, 45];

    const rowY = 200;
    const cards = widths.map((w, i) =>
      s(rect(0, rowY, w, heights[i], {
        fill: true,
        opacity: 0.4,
        corner: 6,
      })),
    );
    // Pin the first card's left edge.
    cards[0].translate.value = { x: 30, y: 0 };
    arrange(cards, "row", { gap: 12, align: 0.5 });

    // Pulse the first card's width to demonstrate reactive reflow.
    this.anim.loop(function* () {
      yield* w0.to(80, 1.2, easeInOut).to(40, 1.2, easeInOut);
    });

    // Caption.
    const rowCenter = computed(() => {
      const last = cards[cards.length - 1].bounds.value;
      const first = cards[0].bounds.value;
      return { x: (first.x + last.x + last.w) / 2, y: rowY };
    });
    s(label(pt(() => rowCenter.value.x, rowY - 18), t("arrange(cards, \"row\", { gap: 12 })").muted(), {
      size: 11,
      align: align.bottom,
    }));
  }
}
