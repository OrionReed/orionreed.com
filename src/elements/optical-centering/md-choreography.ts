import {
  assemble,
  type Content,
  cell,
  centroid,
  circle,
  Diagram,
  easeInOut,
  group,
  label,
  line,
  loop,
  type Mount,
  meanRotation,
  meanScale,
  num,
  orbit,
  play,
  snapshot,
  splay,
  stagger,
  swap,
  vec,
} from "../../minim";

const W = 600;
const H = 360;
const ORBIT_CENTRE = { x: W * 0.28, y: H * 0.55 };

const COLORS = ["#5b8def", "#f5a623", "#e25c5c", "#7ed321", "#9b59b6", "#1abc9c"];

const SCATTER = [
  { x: 110, y: 100 },
  { x: 270, y: 80 },
  { x: 430, y: 110 },
  { x: 140, y: 240 },
  { x: 310, y: 270 },
  { x: 460, y: 220 },
];

const ROW = SCATTER.map((_, i) => ({ x: 100 + i * 80, y: 180 }));

const DIAMOND = [
  { x: W / 2, y: 60 },
  { x: W / 2 + 110, y: 130 },
  { x: W / 2 + 110, y: 230 },
  { x: W / 2, y: 300 },
  { x: W / 2 - 110, y: 230 },
  { x: W / 2 - 110, y: 130 },
];

const PAIRS: [number, number][] = [
  [0, 3],
  [1, 4],
  [2, 5],
];

export class MdChoreography extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    // Each shape carries an orientation tick inside the group so
    // `rotate`/`scale` are visible on top of the centroid translate.
    const shapes = SCATTER.map((p, i) =>
      s(
        group(
          { translate: p },
          circle(vec(0, 0), 18, { fill: COLORS[i] }),
          line(vec(0, 0), vec(14, 0), { stroke: "white", thin: true, opacity: 0.85 }),
        ),
      ),
    );

    const phase = cell<Content>("assemble (row)");
    const c = centroid(...shapes);
    const r = meanRotation(...shapes);
    const k = meanScale(...shapes);
    s(
      label(view.top.down(24), phase, { size: 14, bold: true }),
      label(view.top.down(42), "snapshot · stagger · ramp · similarity · all composing", {
        size: 10,
      }),
      circle(c, 3, { fill: "#1a1a1a", opacity: 0.7 }),
    );

    // Without this, orbit's frame-time integration drifts positions each cycle.
    const reset = snapshot(
      ...shapes.map(sh => sh.translate),
      ...shapes.map(sh => sh.rotate),
      ...shapes.map(sh => sh.scale),
    );

    const orbitRate = num(0);
    const orbitCentre = vec(ORBIT_CENTRE.x, ORBIT_CENTRE.y);

    this.anim.start(
      loop(function* () {
        reset();
        orbitRate.value = 0;

        phase.value = "assemble (row)";
        yield* assemble(shapes, ROW, 0.7, easeInOut);
        yield 0.3;

        phase.value = "assemble (diamond)";
        yield* assemble(shapes, DIAMOND, 0.7, easeInOut);
        yield 0.3;

        phase.value = "splay";
        yield* splay(view.center, 110, shapes, 0.7, easeInOut);
        yield 0.3;

        phase.value = "swap (staggered)";
        yield* stagger(0.18, PAIRS, ([i, j]) => swap(shapes[i], shapes[j], 0.5, easeInOut));
        yield 0.3;

        phase.value = "centroid → corner";
        yield* c.to(ORBIT_CENTRE, 0.7, easeInOut);
        yield 0.3;

        phase.value = "orbit (eased)";
        const rampSequence = play(orbitRate.to(1, 0.5, easeInOut))
          .then(1.4)
          .then(orbitRate.to(0, 0.5, easeInOut));
        yield* play(orbit(orbitCentre, shapes, { period: 2.5, rate: orbitRate })).until(
          rampSequence,
        );
        yield 0.2;

        phase.value = "centroid → centre";
        yield* c.to(view.center.value, 0.7, easeInOut);
        yield 0.4;

        // Group similarity transform: centroid + meanRotation + meanScale
        // — three lensed aggregates animated in parallel, no per-shape math.
        phase.value = "similarity (centroid + rotation + scale)";
        yield [r.to(Math.PI * 0.75, 0.9, easeInOut), k.to({ x: 1.25, y: 1.25 }, 0.9, easeInOut)];
        yield 0.25;
        yield [r.to(-Math.PI * 0.5, 0.9, easeInOut), k.to({ x: 0.7, y: 0.7 }, 0.9, easeInOut)];
        yield 0.25;
        yield [r.to(0, 0.7, easeInOut), k.to({ x: 1, y: 1 }, 0.7, easeInOut)];
        yield 0.3;

        phase.value = "assemble (scatter)";
        yield* assemble(shapes, SCATTER, 0.7, easeInOut);
        yield 0.5;
      }),
    );
  }
}
