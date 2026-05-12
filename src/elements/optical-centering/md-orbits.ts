// Solar system — each body is a child group; transforms compound
// automatically so each body just orbits its parent's local origin.

import {
  Diagram,
  polar,
  Scene,
  type AnyShape,
  bounceIn,
  circle,
  group,
  pt,
  stagger,
  rect,
  signal,
  type Signal,
  zoomOut,
} from "../../minim";

export class MdOrbits extends Diagram {
  protected scene(s: Scene): void {
    const view = s.view(400, 320);

    const sun = s(group({ translate: view.center }));
    sun.add(circle(pt(0, 0), 12, { fill: true }));

    // Integrate ω = 2π/period per frame. Returns the angle Signal
    // (radians, wraps mod 2π).
    const angularMotion = (period: number, sig?: Signal<number>) => {
      const a = sig ?? signal(Math.random() * 2 * Math.PI);
      const omega = (2 * Math.PI) / period;
      this.anim.loop(function* () {
        while (true) {
          const dt = yield;
          a.value = (a.peek() + omega * dt) % (2 * Math.PI);
        }
      });
      return a;
    };

    // Sun spins — the sunspot reveals its rotation.
    sun.add(circle(pt(7, 0), 2, { fill: true, opacity: 0.3 }));
    angularMotion(8, sun.rotate);

    const orbitRing = (parent: AnyShape, r: number) => {
      parent.add(
        circle(pt(0, 0), r, { thin: true, dashed: true, opacity: 0.2 }),
      );
    };

    const planet = (
      parent: AnyShape,
      r: number,
      size: number,
      period: number,
      opts: { spin?: number; ring?: boolean } = {},
    ) => {
      orbitRing(parent, r);
      const angle = angularMotion(period);
      const p = group({ translate: polar(pt(0, 0), r, angle) });
      p.add(circle(pt(0, 0), size, { fill: true }));

      if (opts.ring) {
        p.add(circle(pt(0, 0), size + 4, { thin: true, opacity: 0.4 }));
      }
      if (opts.spin) {
        p.add(rect(pt(size - 1, 0), 4, 1.5, { fill: true }));
        angularMotion(opts.spin, p.rotate);
      }

      parent.add(p);
      return p;
    };

    // Top-level planets — collected for staggered build-in/out.
    // Moons cascade through their parent's opacity/scale.
    const mercury = planet(sun, 28, 3, 4);
    const venus = planet(sun, 50, 4.5, 6.5);

    const earth = planet(sun, 78, 6, 11, { spin: 2 });
    planet(earth, 14, 2, 3); // moon

    const saturn = planet(sun, 110, 5, 16, { ring: true });
    planet(saturn, 12, 1.5, 3.5); // moon a
    planet(saturn, 18, 1.8, 5.5); // moon b

    const outer = planet(sun, 145, 4, 24);
    planet(outer, 11, 1.5, 4); // outer's moon

    // Orbits keep integrating during the off-phase, so phases drift
    // freely and the next intro picks them up wherever they ended up.
    const bodies = [sun, mercury, venus, earth, saturn, outer];
    this.anim.loop(function* () {
      yield* stagger(0.2, bodies, (b) => bounceIn(b, 0.9));
      yield 6;
      yield* stagger(0.1, [...bodies].reverse(), (b) => zoomOut(b, 0.6));
      yield 1;
    });
  }
}
