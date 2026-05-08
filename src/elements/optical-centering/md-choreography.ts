// Choreographer playground. Six shapes cycle through every named
// group operation, one per phase, with a label showing what's
// running. The whole loop sits on top of the Awaitable / lens / tween
// machinery — each phase is one or two lines.
//
// Phases (in order):
//   1. assemble (row)        — explicit shape→target pairing
//   2. assemble (formation)  — diamond layout from positions
//   3. splay                 — radial distribution around a centre
//   4. swap                  — pair-swap three pairs
//   5. stagger pulse         — staggered scale ping
//   6. orbit                 — continuous integrator (3 sec, then cancel)
//   7. centroid → centre     — writable-aggregate group translate
//   8. assemble (scatter)    — back to where we started

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
  splay,
  stagger,
  swap,
  type Content,
} from "../../minim";

const W = 600;
const H = 360;

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

const ROW = [
  { x: 100, y: 180 },
  { x: 180, y: 180 },
  { x: 260, y: 180 },
  { x: 340, y: 180 },
  { x: 420, y: 180 },
  { x: 500, y: 180 },
];

const DIAMOND = [
  { x: W / 2, y: 60 },
  { x: W / 2 + 110, y: 130 },
  { x: W / 2 + 110, y: 230 },
  { x: W / 2, y: 300 },
  { x: W / 2 - 110, y: 230 },
  { x: W / 2 - 110, y: 130 },
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

    // Phase label — top-centre, updated by the loop.
    const phase = signal<Content>("scattered");
    s(
      label(pt(W / 2, 24), phase, {
        size: 14,
        bold: true,
        align: align.center,
        opacity: 0.85,
      }),
    );
    s(
      label(pt(W / 2, 42), "choreographers · one phase per vocabulary item", {
        size: 10,
        align: align.center,
        opacity: 0.45,
      }),
    );

    // Centroid marker — visible across the whole loop. Tracks the
    // group reactively (read side); becomes the tween target in the
    // "centroid → centre" phase (write side).
    const c = centroid(...shapes);
    s(circle(c, 3, { fill: "#1a1a1a", opacity: 0.7 }));

    const centre = pt(W / 2, H / 2);
    const anim = this.anim;

    anim.loop(function* () {
      phase.value = "scattered";
      yield 0.6;

      phase.value = "assemble (row)";
      yield* assemble(shapes, ROW, 0.7, easeInOut);
      yield 0.4;

      phase.value = "assemble (diamond)";
      yield* assemble(shapes, DIAMOND, 0.7, easeInOut);
      yield 0.4;

      phase.value = "splay";
      yield* splay(centre, 110, shapes, 0.7, easeInOut);
      yield 0.4;

      phase.value = "swap pairs";
      // Three independent pair swaps in parallel.
      yield [
        swap(shapes[0], shapes[3], 0.6, easeInOut),
        swap(shapes[1], shapes[4], 0.6, easeInOut),
        swap(shapes[2], shapes[5], 0.6, easeInOut),
      ];
      yield 0.4;

      phase.value = "stagger pulse";
      yield* stagger(0.06, shapes, (sh) =>
        sh.scale.to({ x: 1.4, y: 1.4 }, 0.18).to({ x: 1, y: 1 }, 0.32),
      );
      yield 0.3;

      phase.value = "orbit (3s)";
      const stopOrbit = anim.run(
        orbit(centre, shapes, { radius: 110, period: 2.5 }),
      );
      yield 3;
      stopOrbit();
      yield 0.2;

      phase.value = "centroid → centre";
      yield* c.to({ x: W / 2, y: H / 2 }, 0.8, easeInOut);
      yield 0.4;

      phase.value = "assemble (scatter)";
      yield* assemble(shapes, SCATTER, 0.7, easeInOut);
      yield 0.6;
    });
  }
}
