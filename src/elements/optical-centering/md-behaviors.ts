// Two heads — drift+oscillate above and below — each leading a trail.
// Top uses `attract` (smooth, no overshoot), bottom uses `spring`
// (elastic). Each trail link is a behavior whose target is the
// previous link's signal — no special primitive needed.

import {
  Diagram,
  Mount,
  Anchor,
  attract,
  circle,
  drift,
  label,
  oscillate,
  pt,
  signal,
  spring,
  type Arg,
  type Signal,
} from "../../minim";

const N_TRAIL = 14;

export class MdBehaviors extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 320);
    const wall = view.w.value - 40;

    // Each head: x drifts wall-to-wall (flipping vel at boundaries
    // via a tiny loop), y oscillates around its lane.
    const head = (lane: number, xVelInit: number, freqY: number) => {
      const x = signal(view.center.x.value);
      const y = signal(lane);
      const v = signal(xVelInit);
      this.anim.run(() => drift(x, v));
      this.anim.run(() => oscillate(y, 60, freqY));
      this.anim.run(function* () {
        while (true) {
          yield;
          if (x.value > wall && v.value > 0) v.value = -v.value;
          else if (x.value < 40 && v.value < 0) v.value = -v.value;
        }
      });
      return { x, y };
    };

    const a = head(view.h.value / 3, 180, 0.4);
    const b = head((2 * view.h.value) / 3, -150, 0.7);
    s(
      circle(pt(a.x, a.y), 9, { fill: "#1a1a1a" }),
      circle(pt(b.x, b.y), 9, { fill: "#1a1a1a" }),
    );

    // Trail of N circles, each chasing the previous via `run`. The
    // behavior decides the personality.
    const trail = (
      seedX: Signal<number>,
      seedY: Signal<number>,
      color: string,
      run: (sig: Signal<number>, target: Arg<number>) => void,
    ) => {
      let prevX: Arg<number> = seedX;
      let prevY: Arg<number> = seedY;
      for (let i = 0; i < N_TRAIL; i++) {
        const x = signal(seedX.peek());
        const y = signal(seedY.peek());
        run(x, prevX);
        run(y, prevY);
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

    trail(a.x, a.y, "#5b8def", (sig, target) => {
      this.anim.run(() => attract(sig, target, 9));
    });
    trail(b.x, b.y, "#e25c5c", (sig, target) => {
      this.anim.run(() => spring(sig, target, { stiffness: 180, damping: 18 }));
    });

    s(
      label(
        view.bottom.up(12),
        "head: drift + oscillate. trails: attract (blue, smooth) vs spring (red, elastic)",
        { size: 10, align: Anchor.Center, opacity: 0.55 },
      ),
    );
  }
}
