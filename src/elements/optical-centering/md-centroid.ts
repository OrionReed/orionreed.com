// Group transform via a writable aggregate. `centroid(...shapes)` is a
// `Point` (a `Signal<Vec>`) whose read returns the average of the
// shapes' translates and whose write distributes the delta back to
// every shape — so `centroid.to(target, sec)` animates the group
// rigidly. No separate "move group" API; the lens primitive does it.
//
// Shows three write modes on the same lens, all flowing through the
// same underlying centroid signal:
//
//   - `c.x.to(...)` — per-axis tween (horizontal slide)
//   - `c.y.to(...)` — per-axis tween (vertical slide)
//   - `c.to({...})` — whole-Vec tween (diagonal)
//
// Plus the read side: a label showing live centroid coordinates, and
// thin lines from the centroid to each shape that re-route as the
// shapes move.

import {
  Diagram,
  Scene,
  align,
  centroid,
  circle,
  css,
  easeInOut,
  label,
  line,
  pt,
} from "../../minim";

const W = 600;
const H = 360;
const PAD = 80;

const COLORS = [
  "#5b8def",
  "#f5a623",
  "#e25c5c",
  "#7ed321",
  "#9b59b6",
  "#1abc9c",
];

const POSITIONS = [
  { x: 130, y: 110 },
  { x: 280, y: 80 },
  { x: 420, y: 130 },
  { x: 150, y: 230 },
  { x: 300, y: 260 },
  { x: 440, y: 230 },
];

export class MdCentroid extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, W, H);

    // Each shape's translate is the position. Centroid sums translates;
    // writes distribute as a delta to every translate.
    const shapes = POSITIONS.map((p, i) =>
      s(circle(pt(0, 0), 16, { translate: p, fill: COLORS[i] })),
    );

    const c = centroid(...shapes);

    // Read-side: thin lines + live coordinate label both observe the
    // centroid; both update reactively when any shape moves OR when
    // we tween the group.
    shapes.forEach((sh) =>
      s(line(c, sh.translate, { thin: true, opacity: 0.18 })),
    );

    s(circle(c, 4, { fill: "#1a1a1a" }));
    s(
      label(
        c.up(14),
        c.derive((v) => `centroid (${v.x.toFixed(0)}, ${v.y.toFixed(0)})`),
        { size: 10, opacity: 0.7, align: align.bottom },
      ),
    );

    // Write-side: three tween modalities, all writing through the
    // same lens. Per-axis (`c.x.to`) and whole-Vec (`c.to`) are
    // structurally the same — a Tween of Signal<number> vs Signal<Vec>
    // — and both end up calling the centroid lens's `write` callback,
    // which translates every shape by the delta.
    this.anim.loop(function* () {
      // Slide right — only the x lens writes; shapes' x change, y holds.
      yield* c.x.to(W - PAD, 1.0, easeInOut);
      yield 0.3;
      // Slide down — only the y lens writes.
      yield* c.y.to(H - PAD, 1.0, easeInOut);
      yield 0.3;
      // Diagonal back to top-left — Vec tween, both axes.
      yield* c.to({ x: PAD, y: PAD }, 1.4, easeInOut);
      yield 0.3;
      // Settle in the centre.
      yield* c.to({ x: W / 2, y: H / 2 }, 0.9, easeInOut);
      yield 0.6;
    });

    s(
      label(
        pt(W / 2, H - 14),
        "writable centroid · `c.x.to(...)`, `c.y.to(...)`, `c.to({...})` all distribute deltas",
        { size: 10, align: align.center, opacity: 0.5 },
      ),
    );
  }
}
