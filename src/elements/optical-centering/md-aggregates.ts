// `centroid`/`meanRotation`/`meanScale` composing freely on one set
// of (heterogeneous) shapes, each iteration picking fresh random
// targets so the offsets-are-preserved property is visible.

import * as R from "../rand";
import {
  Diagram,
  Scene,
  Anchor,
  centroid,
  easeInOut,
  label,
  meanRotation,
  meanScale,
  pt,
  rect,
} from "../../minim";

// Heterogeneous sizes, colors, starting rotations — so it reads as
// "each shape's offset survives the tween."
const SHAPES = [
  { x: 130, y: 130, w: 38, h: 10, rot: -0.6, fill: "#5b8def" },
  { x: 280, y: 100, w: 26, h: 8, rot: 0.0, fill: "#f5a623" },
  { x: 430, y: 140, w: 46, h: 14, rot: 0.5, fill: "#e25c5c" },
  { x: 200, y: 240, w: 32, h: 9, rot: -0.3, fill: "#7ed321" },
  { x: 380, y: 250, w: 30, h: 11, rot: 0.7, fill: "#9b59b6" },
];

export class MdAggregates extends Diagram {
  protected scene(s: Scene): void {
    const view = s.view(600, 360);

    const shapes = SHAPES.map((p) =>
      s(
        rect(pt(-p.w / 2, -p.h / 2), p.w, p.h, {
          translate: { x: p.x, y: p.y },
          rotate: p.rot,
          fill: p.fill,
        }),
      ),
    );

    const c = centroid(...shapes);
    const r = meanRotation(...shapes);
    const k = meanScale(...shapes);

    s(
      label(
        view.top.down(30),
        r.derive(
          (rad) =>
            `mean rotation: ${((rad * 180) / Math.PI).toFixed(0)}°    mean scale: ${k.peek().x.toFixed(2)}`,
        ),
        { size: 11, align: Anchor.Center, opacity: 0.7 },
      ),
      label(
        view.bottom.up(14),
        "centroid + meanRotation + meanScale composed in parallel; targets randomized each cycle",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );

    this.anim.loop(function* () {
      const sec = R.float(1.4, 2.0);
      const centre = view.center.value;
      yield [
        c.to(
          {
            x: centre.x + R.float(-90, 90),
            y: centre.y + R.float(-50, 50),
          },
          sec,
          easeInOut,
        ),
        r.to(R.float(-Math.PI, Math.PI), sec, easeInOut),
        k.to({ x: R.float(0.7, 1.5), y: R.float(0.7, 1.5) }, sec, easeInOut),
      ];
      yield 0.3;
    });
  }
}
