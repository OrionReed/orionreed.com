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
  circle,
  drift,
  easeInOut,
  label,
  oscillate,
  pt,
  signal,
  spring,
  type Arg,
  type Point,
  type Signal,
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
      seedX: Signal<number>,
      seedY: Signal<number>,
      color: string,
      attach: (sig: Signal<number>, target: Arg<number>) => void,
    ) => {
      let prevX: Arg<number> = seedX;
      let prevY: Arg<number> = seedY;
      for (let i = 0; i < N_TRAIL; i++) {
        const x = signal(seedX.peek());
        const y = signal(seedY.peek());
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
    const ax = signal(cx);
    const ay = signal(laneY(0));
    const av = signal(180);
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
    // Separate wall-flip and pause loops so neither needs to own dt.
    const bx = signal(cx);
    const by = signal(laneY(1));
    const bv = signal(-150);
    this.anim.run(() => drift(bx, bv));
    this.anim.run(() => oscillate(by, 32, 0.7));
    // Wall flip runs every frame; bv=0 during pauses keeps it dormant.
    this.anim.run(function* () {
      while (true) {
        yield;
        if (bx.value > wall && bv.value > 0) bv.value = -bv.value;
        else if (bx.value < 40 && bv.value < 0) bv.value = -bv.value;
      }
    });
    // Pause loop: run for ~1.5 s → slow to zero → hold → pick direction.
    this.anim.loop(function* () {
      yield 1.5;
      yield* bv.to(0, 0.4, easeInOut);
      yield 0.7;
      bv.value = bx.value < cx ? 155 : -155;
    });
    s(circle(pt(bx, by), 9, { fill: "#1a1a1a" }));
    trail(bx, by, "#e25c5c", (sig, target) => {
      this.anim.run(() => spring(sig, target, { stiffness: 180, damping: 18 }));
    });

    // ── Lane 2: fixed-link chain (teal) ─────────────────────────────
    // Head wanders on a Lissajous path; each frame the chain is solved
    // forward: link[i] is placed exactly LINK_LEN from link[i-1].
    const lc = { x: cx, y: laneY(2) };
    const phase = signal(0);
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
