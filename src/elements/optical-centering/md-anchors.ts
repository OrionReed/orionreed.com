// Stage-2 showcase. A rect rotates and breathes; the writable anchors
// `r.at(u, v)` / `r.top` / `r.right` / … return *post-transform* points
// (parent-frame), so every dependent — bound dots, line endpoints,
// labels — tracks the visual position without an `anim.run` of its own.

import {
  Anchor,
  Diagram,
  Scene,
  circle,
  easeInOut,
  label,
  line,
  rect,
  snapshot,
} from "../../minim";

export class MdAnchors extends Diagram {
  protected scene(s: Scene): void {
    const view = s.view(560, 320);

    // One-shot placement: `set` writes a delta to translate so r's
    // post-transform center lands on view.center exactly.
    const r = s(rect(0, 0, 130, 86, { thin: true, corner: 4 }));
    r.center.set(view.center);

    // Two reactive composers — rotate goes round once per loop, scale
    // breathes through three sizes. Both pivot around r's default
    // origin (AABB center), so the LOCAL center is invariant while
    // every corner/edge anchor sweeps through PARENT frame.
    const reset = snapshot(r.rotate, r.scale);
    this.anim.loop(function* () {
      reset();
      yield [
        r.rotate.to(Math.PI * 2, 6),
        r.scale
          .to({ x: 1.35, y: 1.35 }, 1.5, easeInOut)
          .to({ x: 1, y: 1 }, 1.5, easeInOut)
          .to({ x: 0.7, y: 0.7 }, 1.5, easeInOut)
          .to({ x: 1, y: 1 }, 1.5, easeInOut),
      ];
    });

    // Corner dots — `bind` reads r.at(u, v) every frame and writes it
    // through each dot's anchor lens, which collapses to a translate
    // delta. Net effect: each dot's visual center == the visual corner.
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

    // Mid-edge markers — bound to the cardinals so they slide along
    // the rotating axis.
    const edges = [r.top, r.right, r.bottom, r.left];
    for (const e of edges) {
      const m = s(circle(view.center, 3.5, { fill: "var(--accent)" }));
      m.center.bind(e);
    }

    // Crossed diagonals — endpoints are reactive Points, so each
    // diagonal traces a rotating diameter that breathes with scale.
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

    // Pendulum — a fixed satellite, with a line drawn to r.right.
    // As r rotates, r.right swings around the center: the line acts
    // like a clock hand pinned to the satellite end.
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
