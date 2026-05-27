// md-bounded-slack.ts — `w()` on a saturating lens routes residuals.
//
// Two draggable boxes, A and B. The horizontal gap between them is a
// single Num clamped to [MIN, MAX]:
//
//     const slack = num(80).clamp(MIN, MAX);
//     const B = A.right(w(slack));
//
// Drag A — B follows (forward propagation through the offset).
// Drag B in-range — slack absorbs (A stays put).
// Drag B past a bound — slack saturates at the bound; the unabsorbed
// residual flows to A. The two boxes "stick together" at the bound
// and move as one until you drag back into the slack range.
//
// The clamp acts as a natural hard-stop with A as the fallback
// absorber. No custom lens — the behaviour falls out of composing
// `w()` over a clamp. The wp helper writes the wrapped param first,
// peeks to see what landed, and routes any residual to the receiver.

import {
  Anchor,
  Diagram,
  derive,
  drag,
  label,
  line,
  type Mount,
  num,
  rect,
  Vec,
  vec,
  w,
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

    // Anchor primitive A; slack is a clamped Num gap; B = A.right(w(slack)).
    const A = vec(140, Y_REST);
    const slack = num(80).clamp(MIN, MAX);
    const B = A.right(w(slack));

    s(
      label(
        view.top.down(16),
        "drag B in-range → only slack moves · past a bound → A absorbs the residual",
      ),
    );

    // Connector line between the boxes — colour signals saturation
    // (red at a bound, neutral in-range).
    const atBound = derive(() => {
      const sv = slack.value;
      return sv <= MIN + 0.5 || sv >= MAX - 0.5;
    });
    const connector = line(A, B, {
      stroke: derive(() => (atBound.value ? "#e25c5c" : "var(--text-color, #888)")),
      strokeWidth: derive(() => (atBound.value ? 3 : 1.5)),
      cap: "round",
      opacity: 0.7,
    });
    s(connector);

    // Midpoint label: shows current gap and bounds; turns red at limits.
    const midPos = Vec.derive(() => ({
      x: (A.value.x + B.value.x) / 2,
      y: Y_REST - BOX_SIZE / 2 - 14,
    }));
    s(
      label(
        midPos,
        derive(() => `gap: ${slack.value.toFixed(0)} px  ∈ [${MIN}, ${MAX}]`),
        {
          size: 11,
          align: Anchor.Center,
          fill: derive(() => (atBound.value ? "#e25c5c" : "var(--text-color, #555)")),
        },
      ),
    );

    // Box A (rect top-left + drag target)
    const boxA = s(
      rect(A.left(BOX_SIZE / 2).x, A.up(BOX_SIZE / 2).y, BOX_SIZE, BOX_SIZE, {
        fill: "#5b8def",
        stroke: "white",
        strokeWidth: 2,
        corner: 6,
      }),
    );
    drag(boxA, A);
    boxA.el.style.cursor = "move";
    s(label(A, "A", { fill: "white", bold: true, size: 16, align: Anchor.Center }));

    // Box B
    const boxB = s(
      rect(B.left(BOX_SIZE / 2).x, B.up(BOX_SIZE / 2).y, BOX_SIZE, BOX_SIZE, {
        fill: "#e25c5c",
        stroke: "white",
        strokeWidth: 2,
        corner: 6,
      }),
    );
    drag(boxB, B);
    boxB.el.style.cursor = "move";
    s(label(B, "B", { fill: "white", bold: true, size: 16, align: Anchor.Center }));

    s(
      label(
        view.bottom.up(8),
        "B = A.right(w(slack.clamp(30, 180))) — bounded slack; overflow routes to A",
        { size: 10, align: Anchor.Center },
      ),
    );
  }
}
