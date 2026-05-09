// Composition piece for `motion/behaviors.ts`. Two heads — one
// drift+oscillate above, one below — each leads a snake of followers.
// Top trail uses `attract` (smooth exponential pull, no overshoot),
// bottom uses `spring` (elastic, momentum, overshoots). All four
// behaviors composed in ~50 lines. The trail isn't a special primitive:
// each link is just a behavior whose target is the previous link's
// signal.

import {
  Diagram,
  Scene,
  align,
  attract,
  circle,
  css,
  drift,
  label,
  oscillate,
  pt,
  signal,
  spring,
  type Arg,
  type Signal,
} from "../../minim";

const W = 600;
const H = 320;
const N_TRAIL = 14;

export class MdBehaviors extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, W, H);

    // Each head: x drifts wall-to-wall (with a tiny anonymous loop
    // flipping vel at the boundaries), y oscillates around its lane.
    const head = (lane: number, xVelInit: number, freqY: number) => {
      const x = signal(W / 2);
      const y = signal(lane);
      const v = signal(xVelInit);
      this.anim.run(() => drift(x, v));
      this.anim.run(() => oscillate(y, 60, freqY));
      this.anim.run(function* () {
        while (true) {
          yield;
          if (x.value > W - 40 && v.value > 0) v.value = -v.value;
          else if (x.value < 40 && v.value < 0) v.value = -v.value;
        }
      });
      return { x, y };
    };

    // Top head: rightward, slow wobble.
    const a = head(H / 3, 180, 0.4);
    s(circle(pt(a.x, a.y), 9, { fill: "#1a1a1a" }));

    // Bottom head: leftward, faster wobble.
    const b = head((2 * H) / 3, -150, 0.7);
    s(circle(pt(b.x, b.y), 9, { fill: "#1a1a1a" }));

    // Trail factory — chain of N circles, each chasing the previous
    // via `run`. The behavior decides the personality.
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

    // Top: attract — smooth exponential pull, never overshoots.
    trail(a.x, a.y, "#5b8def", (sig, target) => {
      this.anim.run(() => attract(sig, target, 9));
    });

    // Bottom: spring — momentum, the chain wiggles.
    trail(b.x, b.y, "#e25c5c", (sig, target) => {
      this.anim.run(() => spring(sig, target, { stiffness: 180, damping: 18 }));
    });

    s(
      label(
        pt(W / 2, H - 12),
        "head: drift + oscillate. trails: attract (blue, smooth) vs spring (red, elastic)",
        { size: 10, align: align.center, opacity: 0.55 },
      ),
    );
  }
}
