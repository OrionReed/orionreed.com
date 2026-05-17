// Three trails showing different following primitives.
//
// Lane 0 (top):    attract — exponential pull, no memory
// Lane 1 (middle): spring  — elastic, carries velocity; head pauses
//                            briefly so the trail can visibly catch up
//                            and overshoot before the head bolts again
// Lane 2 (bottom): chain   — fixed-link geometric constraint; no physics
//
// All three are driven by the same minim vocabulary:
//
//   play([drift(x, v), oscillate(y, A, f), bounceFlip(x, v, lo, hi)])
//   loop(function* () { ... pause cycle ... })
//   play(spring(s, target, opts)) — fluent over raw behaviors

import {Diagram, Mount, Anchor, attract, signal, circle, drift, drive, easeInOut, label, loop, num, oscillate, play, vec, spring, type Val, Num, Vec} from "../../minim";

const N_TRAIL = 14;
const N_CHAIN = 10;
const LINK_LEN = 11;

/** A `drift`-with-walls integrator — flips velocity when bounded. One
 *  generator instead of two; the wall-flip is structural, not a
 *  separate concurrent process. */
function bounceFlip(x: Num, v: Num, lo: number, hi: number) {
  return drive(() => {
    if (x.value > hi && v.value > 0) v.value = -v.value;
    else if (x.value < lo && v.value < 0) v.value = -v.value;
  });
}

export class MdBehaviors extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 360);
    const wall = view.w.value - 40;
    const cx = view.w.value / 2;
    const laneY = (i: number) => view.h.value * ((i + 1) / 4);

    // ── Shared trail factory ─────────────────────────────────────────
    // Num circles, each chasing the previous link's position via the
    // caller-supplied `attach` (an `(sig, target) => Animator` that
    // we run as a child of the top-level scene generator).
    const trail = (
      seedX: Num,
      seedY: Num,
      color: string,
      attach: (sig: Num, target: Val<number>) => void,
    ) => {
      let prevX: Val<number> = seedX;
      let prevY: Val<number> = seedY;
      for (let i = 0; i < N_TRAIL; i++) {
        const x = num(seedX.peek());
        const y = num(seedY.peek());
        attach(x, prevX);
        attach(y, prevY);
        s(
          circle(vec(x, y), 7 - i * 0.3, {
            fill: color,
            opacity: 0.85 - i * 0.045,
          }),
        );
        prevX = x;
        prevY = y;
      }
    };

    // ── Lane 0: attract (blue) ──────────────────────────────────────
    const ax = num(cx);
    const ay = num(laneY(0));
    const av = num(180);
    this.anim.start(
      play([
        drift(ax, av),
        oscillate(ay, 32, 0.4),
        bounceFlip(ax, av, 40, wall),
      ]),
    );
    s(circle(vec(ax, ay), 9, { fill: "#1a1a1a" }));
    trail(ax, ay, "#5b8def", (sig, target) => {
      this.anim.start(attract(sig, target, 9));
    });

    // ── Lane 1: spring (red), pauses ────────────────────────────────
    // `byAmp` is reactive so the pause loop can tween it to zero —
    // both axes stop together so the head truly freezes, not just on x.
    const bx = num(cx);
    const by = num(laneY(1));
    const bv = num(-150);
    const byAmp = num(32);
    this.anim.start(
      play([
        drift(bx, bv),
        oscillate(by, byAmp, 0.7),
        bounceFlip(bx, bv, 40, wall),
      ]),
    );
    // Pause: both axes stop together, hold, then snap back to motion.
    // Pure sequence — `play([...]).then(...)` reads as "do these
    // together, then continue".
    this.anim.start(
      loop(function* () {
        yield 1.5;
        yield* play([
          bv.to(0, 0.4, easeInOut),
          byAmp.to(0, 0.4, easeInOut),
        ]);
        yield 0.7;
        byAmp.value = 32;
        bv.value = bx.value < cx ? 155 : -155;
      }),
    );
    s(circle(vec(bx, by), 9, { fill: "#1a1a1a" }));
    trail(bx, by, "#e25c5c", (sig, target) => {
      this.anim.start(spring(sig, target, { stiffness: 200, damping: 15 }));
    });

    // ── Lane 2: fixed-link play(teal) ─────────────────────────────
    // Head wanders on a Lissajous path; each frame the chain is solved
    // forward: link[i] is placed exactly LINK_LEN from link[i-1].
    const lc = { x: cx, y: laneY(2) };
    const phase = num(0);
    this.anim.start(drift(phase, 1));
    const headPos = vec(
      () => lc.x + 90 * Math.sin(phase.value * 1.6),
      () => lc.y + 26 * Math.sin(phase.value * 2.3 + 0.6),
    );
    s(circle(headPos, 9, { fill: "#1a1a1a" }));

    const links: Vec[] = Array.from({ length: N_CHAIN }, (_, i) =>
      vec(lc.x - i * LINK_LEN, lc.y),
    );
    this.anim.start(
      drive(() => {
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
      }),
    );
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
        "attract (smooth) · spring (elastic, pauses) · play(rigid-link)",
        { size: 10, align: Anchor.Center, opacity: 0.55 },
      ),
    );
  }
}
