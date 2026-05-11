// Layout × animation: `arrange` reflowing as multiple rect widths
// pulse, and a fixed-link "snake" (per-frame chain solve where each
// link depends on the previous).

import {
  Diagram,
  Scene,
  Anchor,
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

    // ── arrange + pulsing widths ───────────────────────────────────
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
        align: Anchor.Top,
      }),
    );

    // ── Fixed-link chain "snake" ───────────────────────────────────
    // Head drifts along a Lissajous path; each frame, pull link[i] to
    // be exactly `linkLen` from link[i-1] in its current direction.
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
    const links: Point[] = Array.from({ length: N }, (_, i) =>
      // Spread along -x so the chain starts un-collapsed.
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
        align: Anchor.Left,
      }),
    );
  }
}
