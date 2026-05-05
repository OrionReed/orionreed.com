// Gallery for the transition primitives in `transitions.ts`. Each row
// loops one intro → hold → outro, lagged across N shapes so the intro
// reads as a wave.

import {
  Diagram,
  Pivot,
  Scene,
  Shape,
  circle,
  css,
  label,
  lag,
  pt,
  rect,
  type Animator,
} from "../../minim";
import {
  bounceIn,
  fadeIn,
  fadeOut,
  fadeUp,
  fadeUpOut,
  scaleIn,
  slideIn,
  slideOut,
  spinIn,
  zoomOut,
} from "./transitions";

const LANES = 5;
const LANE_GAP = 50;
const LEFT_PAD = 80;
const RIGHT_PAD = 40;
const COUNT = 6;

interface LaneSpec {
  name: string;
  shape: (s: Scene, x: number, y: number) => Shape;
  intro: (s: Shape) => Animator;
  outro: (s: Shape) => Animator;
}

export class MdTransitions extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected setup(s: Scene): void {
    const W = LEFT_PAD + RIGHT_PAD + 360;
    const H = LANES * LANE_GAP + 30;
    s.view(0, 0, W, H);

    const lanes: LaneSpec[] = [
      {
        name: "fadeUp",
        shape: (sc, x, y) => sc(circle(pt(x, y), 10, { fill: true })),
        intro: (sh) => fadeUp(sh),
        outro: (sh) => fadeUpOut(sh),
      },
      {
        name: "scaleIn",
        shape: (sc, x, y) => sc(rect(pt(x, y), 18, 18, { fill: true })),
        intro: (sh) => scaleIn(sh, 0.35),
        outro: (sh) => zoomOut(sh, 0.25),
      },
      {
        name: "bounceIn",
        shape: (sc, x, y) => sc(circle(pt(x, y), 12, { fill: true })),
        intro: (sh) => bounceIn(sh, 0.55),
        outro: (sh) => zoomOut(sh, 0.25),
      },
      {
        name: "slideIn",
        shape: (sc, x, y) => sc(rect(pt(x, y), 22, 12, { fill: true })),
        intro: (sh) => slideIn(sh, "left", 0.4, 40),
        outro: (sh) => slideOut(sh, "right", 0.3, 40),
      },
      {
        name: "spinIn",
        shape: (sc, x, y) => sc(rect(pt(x, y), 18, 18, { fill: true })),
        intro: (sh) => spinIn(sh, 0.6),
        outro: (sh) => fadeOut(sh, 0.25),
      },
    ];

    const stride = (W - LEFT_PAD - RIGHT_PAD) / (COUNT - 1);

    lanes.forEach((lane, laneIdx) => {
      const y = 25 + laneIdx * LANE_GAP;
      s(label(pt(10, y), lane.name, { size: 12, anchor: Pivot.LEFT, opacity: 0.5 }));

      const shapes = Array.from({ length: COUNT }, (_, i) =>
        lane.shape(s, LEFT_PAD + i * stride, y),
      );

      this.anim.loop(function* () {
        yield* lag(0.07, ...shapes.map(lane.intro));
        yield 0.6;
        yield* lag(0.04, ...shapes.map(lane.outro));
        yield 0.4;
      });
    });
  }
}
