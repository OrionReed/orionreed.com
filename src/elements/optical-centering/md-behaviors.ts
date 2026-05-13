// Three trails showing different following primitives.
//
// Lane 0 (top):    attract — exponential pull, no memory
// Lane 1 (middle): spring  — elastic, carries velocity; head pauses
//                            briefly so the trail can visibly catch up
//                            and overshoot before the head bolts again
// Lane 2 (bottom): chain   — fixed-link geometric constraint; no physics

import {
  Diagram,
  Mount,
  Anchor,
  attract,
  cell,
  circle,
  drift,
  easeInOut,
  label,
  oscillate,
  pt,
  spring,
  type Arg,
  type Cell,
  type Point,
} from "../../minim";

const N_TRAIL = 14;
const N_CHAIN = 10;
const LINK_LEN = 11;

export class MdBehaviors extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 360);
    const wall = view.w.value - 40;
    const cx = view.w.value / 2;

    // Lane y-centres: even thirds of the interior.
    const laneY = (i: number) => view.h.value * ((i + 1) / 4);

    // ── Shared trail factory ─────────────────────────────────────────
    // N circles, each chasing the previous link's position.
    const trail = (
      seedX: Cell<number>,
      seedY: Cell<number>,
      color: string,
      attach: (sig: Cell<number>, target: Arg<number>) => void,
    ) => {
      let prevX: Arg<number> = seedX;
      let prevY: Arg<number> = seedY;
      for (let i = 0; i < N_TRAIL; i++) {
        const x = cell(seedX.peek());
        const y = cell(seedY.peek());
        attach(x, prevX);
        attach(y, prevY);
        s(
          circle(pt(x, y), 7 - i * 0.3, {
            fill: color,
            opacity: 0.85 - i * 0.045,
          }),
        );
        prevX = x;
        prevY = y;
      }
    };

    // ── Lane 0: attract (blue) ──────────────────────────────────────
    const ax = cell(cx);
    const ay = cell(laneY(0));
    const av = cell(180);
    this.anim.run(() => drift(ax, av));
    this.anim.run(() => oscillate(ay, 32, 0.4));
    this.anim.run(function* () {
      while (true) {
        yield;
        if (ax.value > wall && av.value > 0) av.value = -av.value;
        else if (ax.value < 40 && av.value < 0) av.value = -av.value;
      }
    });
    s(circle(pt(ax, ay), 9, { fill: "#1a1a1a" }));
    trail(ax, ay, "#5b8def", (sig, target) => {
      this.anim.run(() => attract(sig, target, 9));
    });

    // ── Lane 1: spring (red), pauses ────────────────────────────────
    // byAmp is reactive so the pause loop can tween it to zero — this
    // stops both axes so the head truly freezes, not just on x.
    const bx = cell(cx);
    const by = cell(laneY(1));
    const bv = cell(-150);
    const byAmp = cell(32);
    this.anim.run(() => drift(bx, bv));
    this.anim.run(() => oscillate(by, byAmp, 0.7));
    // Wall flip runs every frame; bv=0 during pauses keeps it dormant.
    this.anim.run(function* () {
      while (true) {
        yield;
        if (bx.value > wall && bv.value > 0) bv.value = -bv.value;
        else if (bx.value < 40 && bv.value < 0) bv.value = -bv.value;
      }
    });
    // Pause: both axes stop together, hold, then snap back to motion.
    this.anim.loop(function* () {
      yield 1.5;
      yield [bv.to(0, 0.4, easeInOut), byAmp.to(0, 0.4, easeInOut)];
      yield 0.7;
      byAmp.value = 32;
      bv.value = bx.value < cx ? 155 : -155;
    });
    s(circle(pt(bx, by), 9, { fill: "#1a1a1a" }));
    trail(bx, by, "#e25c5c", (sig, target) => {
      this.anim.run(() => spring(sig, target, { stiffness: 200, damping: 15 }));
    });

    // ── Lane 2: fixed-link chain (teal) ─────────────────────────────
    // Head wanders on a Lissajous path; each frame the chain is solved
    // forward: link[i] is placed exactly LINK_LEN from link[i-1].
    const lc = { x: cx, y: laneY(2) };
    const phase = cell(0);
    this.anim.run(() => drift(phase, 1));
    const headPos = pt(
      () => lc.x + 90 * Math.sin(phase.value * 1.6),
      () => lc.y + 26 * Math.sin(phase.value * 2.3 + 0.6),
    );
    s(circle(headPos, 9, { fill: "#1a1a1a" }));

    const links: Point[] = Array.from({ length: N_CHAIN }, (_, i) =>
      pt(lc.x - i * LINK_LEN, lc.y),
    );
    this.anim.run(function* () {
      while (true) {
        yield;
        let prev = headPos.value;
        for (let i = 0; i < N_CHAIN; i++) {
          const cur = links[i].peek();
          const dx = cur.x - prev.x;
          const dy = cur.y - prev.y;
          const dist = Math.hypot(dx, dy) || 0.001;
          links[i].value = {
            x: prev.x + (dx / dist) * LINK_LEN,
            y: prev.y + (dy / dist) * LINK_LEN,
          };
          prev = links[i].value;
        }
      }
    });
    for (let i = 0; i < N_CHAIN; i++) {
      s(
        circle(links[i], 6.5 - i * 0.45, {
          fill: "#1abc9c",
          opacity: 0.85 - i * 0.065,
        }),
      );
    }

    s(
      label(
        view.bottom.up(12),
        "attract (smooth) · spring (elastic, pauses) · chain (rigid-link)",
        { size: 10, align: Anchor.Center, opacity: 0.55 },
      ),
    );
  }
}
