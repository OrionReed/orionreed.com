// md-bounded-slack.ts — `share()` on a saturating lens routes residuals.
//
// Two draggable boxes linked edge-to-edge. The relationship is written
// directly between the shapes' writable anchors:
//
//     const bCenter = boxA.right.right(share(slack)).right(BOX_SIZE / 2);
//     const boxB    = rect(bCenter, BOX_SIZE, BOX_SIZE);
//
// `boxA.right` is the parent-frame right-edge anchor (writes shift A's
// translate). Shifting it by `share(slack)` lands on B's left edge; adding
// half-width yields B's centre, which is what `rect(center, w, h)` wants.
//
// Drag A — B follows (forward propagation through the chain).
// Drag B in-range — slack absorbs (A stays put).
// Drag B past a bound — slack saturates; the unabsorbed residual flows
// up the chain into A. The two boxes "stick together" at the bound and
// move as one until you drag back in.

import {
  Anchor,
  Diagram,
  derive,
  drag,
  label,
  line,
  type Mount,
  num,
  own,
  rect,
  vec,
} from "../../minim";

const W = 660;
const H = 280;
const Y_REST = 160;
const MIN = 30;
const MAX = 180;
const BOX_SIZE = 56;

export class MdBoundedSlack extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const slack = num(80).clamp(MIN, MAX);

    const boxA = s(
      rect(vec(140, Y_REST), BOX_SIZE, BOX_SIZE, {
        fill: "#5b8def",
        stroke: "white",
        strokeWidth: 2,
        corner: 6,
      }),
    );

    // B's left edge = A's right edge + slack; centre = + half-width.
    const bCenter = boxA.right.right(own(slack)).right(BOX_SIZE / 2);
    const boxB = s(
      rect(bCenter, BOX_SIZE, BOX_SIZE, {
        fill: "#e25c5c",
        stroke: "white",
        strokeWidth: 2,
        corner: 6,
      }),
    );

    drag(boxA, boxA.center);
    drag(boxB, bCenter);
    boxA.el.style.cursor = "move";
    boxB.el.style.cursor = "move";

    const atBound = derive(() => {
      const sv = slack.value;
      return sv <= MIN + 0.5 || sv >= MAX - 0.5;
    });

    // Connector drawn between the inner edges — it IS the slack gap.
    s(
      line(boxA.right, boxB.left, {
        stroke: derive(() => (atBound.value ? "#e25c5c" : "var(--text-color, #888)")),
        strokeWidth: derive(() => (atBound.value ? 3 : 1.5)),
        cap: "round",
        opacity: 0.7,
      }),
    );

    s(
      label(
        view.top.down(16),
        "drag B in-range → only slack moves · past a bound → A absorbs the residual",
      ),
      label(
        boxA.top.lerp(boxB.top, 0.5).up(14),
        derive(() => `gap: ${slack.value.toFixed(0)} px  ∈ [${MIN}, ${MAX}]`),
        {
          size: 11,
          align: Anchor.Center,
          fill: derive(() => (atBound.value ? "#e25c5c" : "var(--text-color, #555)")),
        },
      ),
      label(boxA.center, "A", { fill: "white", bold: true, size: 16, align: Anchor.Center }),
      label(boxB.center, "B", { fill: "white", bold: true, size: 16, align: Anchor.Center }),
      label(
        view.bottom.up(8),
        "boxB.left = boxA.right.right(share(slack.clamp(30, 180))) — edge-to-edge gap; overflow routes to A",
        { size: 10, align: Anchor.Center },
      ),
    );
  }
}
