// Choreographer playground. Six shapes cycle through every named
// group operation; `snapshot` captures the initial pose so each
// iteration starts identical (perfect loop). Phases compose freely:
// staggered swaps (per-pair lag), eased orbit (rate-signal tween),
// writable centroid (group translate via aggregate). The whole loop
// body is one generator that reads top-to-bottom.

import {
  Diagram,
  Scene,
  align,
  assemble,
  centroid,
  circle,
  css,
  easeInOut,
  label,
  orbit,
  pt,
  signal,
  snapshot,
  splay,
  stagger,
  swap,
  type Content,
} from "../../minim";

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

// Pair indices for the staggered swap phase. (0↔3, 1↔4, 2↔5) opposes
// each diamond vertex with the one across the centre.
const PAIRS: [number, number][] = [
  [0, 3],
  [1, 4],
  [2, 5],
];

export class MdChoreography extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, W, H);

    const shapes = SCATTER.map((p, i) =>
      s(circle(pt(0, 0), 18, { translate: p, fill: COLORS[i] })),
    );

    const phase = signal<Content>("assemble (row)");
    s(label(pt(W / 2, 24), phase, {
      size: 14, bold: true, align: align.center, opacity: 0.85,
    }));
    s(label(pt(W / 2, 42), "snapshot · stagger · ramp · centroid · all composing", {
      size: 10, align: align.center, opacity: 0.45,
    }));

    const c = centroid(...shapes);
    s(circle(c, 3, { fill: "#1a1a1a", opacity: 0.7 }));

    // Capture initial translates so each loop iteration starts from
    // the exact same pose — orbit's frame-time integration would
    // otherwise drift positions slightly per cycle.
    const reset = snapshot(...shapes.map((sh) => sh.translate));

    // Orbit speed as a signal — tween it to ease in / hold / ease out.
    const orbitRate = signal(0);
    const orbitCentre = pt(ORBIT_CENTRE.x, ORBIT_CENTRE.y);

    const anim = this.anim;
    anim.loop(function* () {
      reset();
      orbitRate.value = 0;

      phase.value = "assemble (row)";
      yield* assemble(shapes, ROW, 0.7, easeInOut);
      yield 0.3;

      phase.value = "assemble (diamond)";
      yield* assemble(shapes, DIAMOND, 0.7, easeInOut);
      yield 0.3;

      phase.value = "splay";
      yield* splay(pt(W / 2, H / 2), 110, shapes, 0.7, easeInOut);
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
      const stopOrbit = anim.run(
        orbit(orbitCentre, shapes, { period: 2.5, rate: orbitRate }),
      );
      yield* orbitRate.to(1, 0.5, easeInOut);  // ease in
      yield 1.4;                                // full speed
      yield* orbitRate.to(0, 0.5, easeInOut);  // ease out
      stopOrbit();
      yield 0.2;

      phase.value = "centroid → centre";
      yield* c.to({ x: W / 2, y: H / 2 }, 0.7, easeInOut);
      yield 0.4;

      phase.value = "assemble (scatter)";
      yield* assemble(shapes, SCATTER, 0.7, easeInOut);
      yield 0.5;
    });
  }
}
