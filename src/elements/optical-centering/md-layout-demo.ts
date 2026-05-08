// Showcases the layout primitives + their interaction with animation:
//
//   - `align` namespace for label alignment.
//   - `bounds.at(u, v)` for arbitrary anchor points on a rect.
//   - `arrange(shapes, axis, opts)` for reactive row/column layout.
//   - Multiple simultaneous size animations flowing through `arrange`
//     to reflow neighbours.
//   - A fixed-link chain "snake" — each tail link sits at a constant
//     distance from its predecessor, dragged along when the head moves.
//     The classic per-frame chain solve: dependency graph (link i
//     depends on link i-1) is the layout relation; the per-frame
//     sweep is the animation. Both share signals as their substrate.

import {
  Diagram,
  Scene,
  align,
  arrange,
  circle,
  css,
  easeInOut,
  label,
  pt,
  rect,
  signal,
  speed,
  t,
  type Point,
} from "../../minim";

export class MdLayoutDemo extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 560px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, 520, 360);

    // ── Middle: arrange() with multiple simultaneous size animations ─
    const w0 = signal(40);
    const w2 = signal(36);
    const w4 = signal(48);
    const widths = [w0, signal(56), w2, signal(64), w4];
    const heights = [40, 30, 50, 35, 45];

    const cards = widths.map((w, i) =>
      s(rect(0, 200, w, heights[i], { fill: true, opacity: 0.4, corner: 6 })),
    );
    cards[0].translate.value = { x: 30, y: 0 };
    arrange(cards, "row", { gap: 12, align: 0.5 });

    // Three widths pulsing on staggered cycles — each one's neighbours
    // reflow live through `arrange`.
    this.anim.loop(function* () {
      yield* w0.to(80, 1.2, easeInOut).to(40, 1.2, easeInOut);
    });
    this.anim.loop(function* () {
      yield* w2.to(72, 0.9, easeInOut).to(36, 0.9, easeInOut);
    });
    this.anim.loop(function* () {
      yield* w4.to(28, 1.4, easeInOut).to(48, 1.4, easeInOut);
    });

    s(
      label(pt(170, 252), t("arrange + multiple size animations").muted(), {
        size: 11,
        align: align.top,
      }),
    );

    // ── Bottom: fixed-link chain "snake" ────────────────────────────
    // Each tail link is at a fixed `linkLen` from its predecessor.
    // The head drifts along a Lissajous path; the chain solves
    // forward each frame: pull link[i] to be exactly `linkLen` away
    // from link[i-1] in the direction it currently sits.
    const cx = 260;
    const cy = 310;
    const phase = signal(0);
    this.anim.run(speed(phase, 1));
    const headPos = pt(
      () => cx + 98 * Math.sin(phase.value * 1.6),
      () => cy + 38 * Math.sin(phase.value * 2.3 + 0.6),
    );
    s(circle(headPos, 8, { fill: true }));

    const N = 8;
    const linkLen = 11;
    // `Point`s are writable `Signal<Vec>`s — pass directly to `circle`,
    // peek/write via `.value` exactly like a raw signal would.
    const links: Point[] = Array.from({ length: N }, (_, i) =>
      // Initial spread along -x so the chain starts un-collapsed.
      pt(cx - i * linkLen, cy),
    );

    this.anim.run(function* () {
      while (true) {
        yield;
        let prev = headPos.value;
        for (let i = 0; i < N; i++) {
          const cur = links[i].peek();
          const dx = cur.x - prev.x;
          const dy = cur.y - prev.y;
          const dist = Math.hypot(dx, dy) || 0.001;
          const next = {
            x: prev.x + (dx / dist) * linkLen,
            y: prev.y + (dy / dist) * linkLen,
          };
          links[i].value = next;
          prev = next;
        }
      }
    });

    for (let i = 0; i < N; i++) {
      s(
        circle(links[i], 6.5 - i * 0.45, {
          fill: true,
          opacity: 0.6 - i * 0.05,
        }),
      );
    }

    s(
      label(pt(20, 280), t("layout × animation: fixed-link chain").muted(), {
        size: 11,
        align: align.left,
      }),
    );
  }
}
