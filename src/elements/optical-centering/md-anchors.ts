import {Anchor, Diagram, Mount, circle, easeInOut, label, line, loop, rect, snapshot} from "../../minim";

export class MdAnchors extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 320);

    const r = s(rect(0, 0, 130, 86, { thin: true, corner: 4 }));
    r.center.set(view.center);

    const reset = snapshot(r.rotate, r.scale);
    this.anim.start(loop(function* () {
      reset();
      yield [
        r.rotate.to(Math.PI * 2, 6),
        r.scale
          .to({ x: 1.35, y: 1.35 }, 1.5, easeInOut)
          .to({ x: 1, y: 1 }, 1.5, easeInOut)
          .to({ x: 0.7, y: 0.7 }, 1.5, easeInOut)
          .to({ x: 1, y: 1 }, 1.5, easeInOut),
      ];
    }));

    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const [u, v] of corners) {
      const dot = s(circle(view.center, 5, { fill: true }));
      dot.center.bind(r.at(u, v));
    }

    const edges = [r.top, r.right, r.bottom, r.left];
    for (const e of edges) {
      const m = s(circle(view.center, 3.5, { fill: "var(--accent)" }));
      m.center.bind(e);
    }

    s(
      line(r.at(0, 0), r.at(1, 1), {
        thin: true,
        dashed: true,
        opacity: 0.3,
      }),
      line(r.at(1, 0), r.at(0, 1), {
        thin: true,
        dashed: true,
        opacity: 0.3,
      }),
    );

    const sat = s(circle(view.right.left(48), 7, { fill: true, opacity: 0.6 }));
    s(line(sat.center, r.right, { thin: true, opacity: 0.4 }));

    s(
      label(view.top.down(20), "writable anchors — bind tracks rotate × scale", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.6,
      }),
      label(
        view.bottom.up(16),
        "dot.center.bind(r.at(u, v))  ·  line(sat.center, r.right)",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
