import {Anchor, Diagram, Dir, Mount, Shape, bounceIn, circle, fadeOut, fadeUp, fadeUpOut, label, loop, vec, rect, scaleIn, slideIn, slideOut, spinIn, stagger, zoomOut, type Yieldable} from "../../minim";

const LANES = 5;
const LANE_GAP = 50;
const LEFT_PAD = 80;
const RIGHT_PAD = 40;
const COUNT = 6;

interface LaneSpec {
  name: string;
  shape: (s: Mount, x: number, y: number) => Shape;
  intro: (s: Shape) => Yieldable;
  outro: (s: Shape) => Yieldable;
}

export class MdTransitions extends Diagram {
  protected scene(s: Mount): void {
    const W = LEFT_PAD + RIGHT_PAD + 360;
    const H = LANES * LANE_GAP + 30;
    this.view(W, H);

    const lanes: LaneSpec[] = [
      {
        name: "fadeUp",
        shape: (sc, x, y) => sc(circle(vec(x, y), 10, { fill: true })),
        intro: (sh) => fadeUp(sh),
        outro: (sh) => fadeUpOut(sh),
      },
      {
        name: "scaleIn",
        shape: (sc, x, y) => sc(rect(vec(x, y), 18, 18, { fill: true })),
        intro: (sh) => scaleIn(sh, 0.35),
        outro: (sh) => zoomOut(sh, 0.25),
      },
      {
        name: "bounceIn",
        shape: (sc, x, y) => sc(circle(vec(x, y), 12, { fill: true })),
        intro: (sh) => bounceIn(sh, 0.55),
        outro: (sh) => zoomOut(sh, 0.25),
      },
      {
        name: "slideIn",
        shape: (sc, x, y) => sc(rect(vec(x, y), 22, 12, { fill: true })),
        intro: (sh) => slideIn(sh, Dir.Left, 0.4, 40),
        outro: (sh) => slideOut(sh, Dir.Right, 0.3, 40),
      },
      {
        name: "spinIn",
        shape: (sc, x, y) => sc(rect(vec(x, y), 18, 18, { fill: true })),
        intro: (sh) => spinIn(sh, 0.6),
        outro: (sh) => fadeOut(sh, 0.25),
      },
    ];

    const stride = (W - LEFT_PAD - RIGHT_PAD) / (COUNT - 1);

    lanes.forEach((lane, laneIdx) => {
      const y = 25 + laneIdx * LANE_GAP;
      s(label(vec(10, y), lane.name, { size: 12, align: Anchor.Left, opacity: 0.5 }));

      const shapes = Array.from({ length: COUNT }, (_, i) =>
        lane.shape(s, LEFT_PAD + i * stride, y),
      );

      this.anim.start(loop(function* () {
        yield* stagger(0.07, shapes, lane.intro);
        yield 0.6;
        yield* stagger(0.04, shapes, lane.outro);
        yield 0.4;
      }));
    });
  }
}
