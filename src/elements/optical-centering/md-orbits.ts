import {
  type AnyShape,
  bounceIn,
  circle,
  Diagram,
  drive,
  group,
  loop,
  Mount,
  num,
  polar,
  rect,
  stagger,
  vec,
  zoomOut,
} from "../../minim";

const TAU = Math.PI * 2;

export class MdOrbits extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(400, 320);

    // One `time: Num` drives the whole solar system. Each body's angle is
    // `time.affine(τ/period, phase)` — an invertible 1-D affine chain — so
    // every visible angle is deterministic in time. Reads go time → angle
    // for the visuals; the same chain accepts inverse writes if a body
    // ever gets dragged (see md-solar-system for that variant).
    const time = num(0);
    this.anim.start(
      drive(tick => {
        time.value = time.peek() + tick.dt;
      }),
    );

    /** Angle = `τ·time/period + phase` (mod 2π implicitly via cos/sin). */
    const angleOf = (period: number, phase = 0) => time.affine(TAU / period, phase);

    const sun = s(
      group(
        { translate: view.center, rotate: angleOf(8) },
        circle(vec(0, 0), 12, { fill: true }),
        circle(vec(7, 0), 2, { fill: true, opacity: 0.3 }),
      ),
    );

    const orbitRing = (parent: AnyShape, r: number) => {
      parent.add(circle(vec(0, 0), r, { thin: true, dashed: true, opacity: 0.2 }));
    };

    const planet = (
      parent: AnyShape,
      r: number,
      size: number,
      period: number,
      opts: { spin?: number; ring?: boolean; phase?: number } = {},
    ) => {
      orbitRing(parent, r);
      const phase = opts.phase ?? Math.random() * TAU;
      const p = group({
        translate: polar(vec(0, 0), r, angleOf(period, phase)),
        // When `opts.spin` is set, the body's group also rotates at its
        // own rate — independent affine chain on the same time signal.
        rotate: opts.spin !== undefined ? angleOf(opts.spin, phase) : undefined,
      });
      p.add(circle(vec(0, 0), size, { fill: true }));

      if (opts.ring) {
        p.add(circle(vec(0, 0), size + 4, { thin: true, opacity: 0.4 }));
      }
      if (opts.spin !== undefined) {
        p.add(rect(vec(size - 1, 0), 4, 1.5, { fill: true }));
      }

      parent.add(p);
      return p;
    };

    const mercury = planet(sun, 28, 3, 4);
    const venus = planet(sun, 50, 4.5, 6.5);

    const earth = planet(sun, 78, 6, 11, { spin: 2 });
    planet(earth, 14, 2, 3);

    const saturn = planet(sun, 110, 5, 16, { ring: true });
    planet(saturn, 12, 1.5, 3.5);
    planet(saturn, 18, 1.8, 5.5);

    const outer = planet(sun, 145, 4, 24);
    planet(outer, 11, 1.5, 4);

    const bodies = [sun, mercury, venus, earth, saturn, outer];
    this.anim.start(
      loop(function* () {
        yield* stagger(0.2, bodies, b => bounceIn(b, 0.9));
        yield 6;
        yield* stagger(0.1, [...bodies].reverse(), b => zoomOut(b, 0.6));
        yield 1;
      }),
    );
  }
}
