import {Diagram, Mount, Anchor, assemble, centroid, play, circle, easeInOut, label, loop, num, orbit, signal, vec, snapshot, splay, stagger, swap, type Content} from "../../minim";

const W = 600;
const H = 360;
const ORBIT_CENTRE = { x: W * 0.28, y: H * 0.55 };

const COLORS = [
  "#5b8def",
  "#f5a623",
  "#e25c5c",
  "#7ed321",
  "#9b59b6",
  "#1abc9c",
];

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

    const shapes = SCATTER.map((p, i) =>
      s(circle(vec(0, 0), 18, { translate: p, fill: COLORS[i] })),
    );

    const phase = signal<Content>("assemble (row)");
    const c = centroid(...shapes);
    s(
      label(view.top.down(24), phase, {
        size: 14, bold: true, align: Anchor.Center, opacity: 0.85,
      }),
      label(view.top.down(42), "snapshot · stagger · ramp · centroid · all composing", {
        size: 10, align: Anchor.Center, opacity: 0.45,
      }),
      circle(c, 3, { fill: "#1a1a1a", opacity: 0.7 }),
    );

    // Without this, orbit's frame-time integration drifts positions each cycle.
    const reset = snapshot(...shapes.map((sh) => sh.translate));

    const orbitRate = num(0);
    const orbitCentre = vec(ORBIT_CENTRE.x, ORBIT_CENTRE.y);

    this.anim.start(loop(function* () {
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
      yield* stagger(0.18, PAIRS, ([i, j]) =>
        swap(shapes[i], shapes[j], 0.5, easeInOut),
      );
      yield 0.3;

      phase.value = "centroid → corner";
      yield* c.to(ORBIT_CENTRE, 0.7, easeInOut);
      yield 0.3;

      phase.value = "orbit (eased)";
      const rampSequence = play(orbitRate.to(1, 0.5, easeInOut))
        .then(1.4)
        .then(orbitRate.to(0, 0.5, easeInOut));
      yield* play(orbit(orbitCentre, shapes, { period: 2.5, rate: orbitRate }))
        .until(rampSequence);
      yield 0.2;

      phase.value = "centroid → centre";
      yield* c.to(view.center.value, 0.7, easeInOut);
      yield 0.4;

      phase.value = "assemble (scatter)";
      yield* assemble(shapes, SCATTER, 0.7, easeInOut);
      yield 0.5;
    }));
  }
}
