// Solar system — every body is a child group whose `translate` and
// `rotate` cascade to its own children. The moon is a child of earth,
// earth is a child of sun, so their transforms compound automatically.
// No coordinate juggling: each body just orbits its parent's local
// origin. Tree-coordinate exercise.

import {
  Diagram,
  Scene,
  Shape,
  circle,
  computed,
  css,
  group,
  lag,
  pt,
  rect,
  signal,
  type Signal,
} from "../../minim";
import { bounceIn, zoomOut } from "./transitions";

export class MdOrbits extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 480px;
    }
  `;

  protected setup(s: Scene): void {
    const W = 400;
    const H = 320;
    s.view(0, 0, W, H);

    const sun = s(group({ translate: { x: W / 2, y: H / 2 } }));
    sun.add(circle(pt(0, 0), 12, { fill: true }));

    // Continuous angular motion: integrate `omega = 2π/period` per
    // frame from `dt`. Linear by construction — no easing, no reset
    // discontinuity. Returns the angle Signal (radians, wraps mod 2π).
    const angularMotion = (period: number, sig?: Signal<number>) => {
      const a = sig ?? signal(Math.random() * 2 * Math.PI);
      const omega = (2 * Math.PI) / period;
      this.anim.loop(function* () {
        while (true) {
          const dt: number = yield;
          a.value = (a.peek() + omega * dt) % (2 * Math.PI);
        }
      });
      return a;
    };

    // Sun spins slowly — the sunspot child reveals its rotation.
    sun.add(circle(pt(7, 0), 2, { fill: true, opacity: 0.3 }));
    angularMotion(8, sun.rotate);

    // Faint dashed orbit ring at radius `r`, parented to `parent`.
    const orbitRing = (parent: Shape, r: number) => {
      parent.add(
        circle(pt(0, 0), r, { thin: true, dashed: true, opacity: 0.2 }),
      );
    };

    // A planet at radius `r` from `parent`'s origin, with given size and
    // orbital period (seconds). Optionally spins on its axis (`spin`).
    const planet = (
      parent: Shape,
      r: number,
      size: number,
      period: number,
      opts: { spin?: number; ring?: boolean } = {},
    ) => {
      orbitRing(parent, r);
      const angle = angularMotion(period);
      const p = group({
        translate: computed(() => ({
          x: r * Math.cos(angle.value),
          y: r * Math.sin(angle.value),
        })),
      });
      p.add(circle(pt(0, 0), size, { fill: true }));

      if (opts.ring) {
        // A flat ring around the planet — child of planet so it follows.
        p.add(circle(pt(0, 0), size + 4, { thin: true, opacity: 0.4 }));
      }

      if (opts.spin) {
        // A small marker on the planet's surface — visualizes spin.
        p.add(rect(pt(size - 1, 0), 4, 1.5, { fill: true }));
        angularMotion(opts.spin, p.rotate);
      }

      parent.add(p);
      return p;
    };

    // Top-level planets — collected so the build-in/out cycle can
    // animate them in lagged sequence. Moons cascade through their
    // parent's transform, so they don't need their own transitions.
    const mercury = planet(sun, 28, 3, 4);
    const venus = planet(sun, 50, 4.5, 6.5);

    const earth = planet(sun, 78, 6, 11, { spin: 2 });
    planet(earth, 14, 2, 3); // moon

    const saturn = planet(sun, 110, 5, 16, { ring: true });
    planet(saturn, 12, 1.5, 3.5); // moon a
    planet(saturn, 18, 1.8, 5.5); // moon b

    const outer = planet(sun, 145, 4, 24);
    planet(outer, 11, 1.5, 4); // outer's moon

    // Build-in / build-out cycle. Apply transitions to top-level groups
    // only — moons inherit through their parents' opacity/scale.
    // Orbits keep integrating during the off-phase so phases drift; the
    // next intro picks them up wherever they ended up.
    const bodies = [sun, mercury, venus, earth, saturn, outer];
    this.anim.loop(function* () {
      yield* lag(0.2, ...bodies.map((b) => bounceIn(b, 0.9)));
      yield 6;
      yield* lag(0.1, ...[...bodies].reverse().map((b) => zoomOut(b, 0.6)));
      yield 1;
    });
  }
}
