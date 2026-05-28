// md-slack-chain.ts — four boxes connected by `own()`-clamped gaps in a
// right/down/right zig-zag. Each gap has different dynamics:
//
//   A → B   horizontal, tight hard clamp [30, 110].
//   B ↓ C   vertical, wide hard clamp [40, 200] (stretchy room to roam).
//   C → D   horizontal, "soft compress" — a non-PG lens that resists
//           pushing the gap below ~80. The lens accepts only 1/k of any
//           further shrink request, sending the rest as residual to C.
//           Pushing D into C feels squishy: C visibly tags along, with
//           the coupling strengthening as the gap narrows. Hard cap at 30.
//
// All four boxes are draggable. Each `own()` slack is symmetric: drag
// any box, the chain propagates through every gap with residual flow
// at saturation. Drift-on-saturation accepts the new settled state, so
// back-drags after extension contract smoothly instead of getting stuck.

import {
  Anchor,
  Diagram,
  derive,
  drag,
  label,
  line,
  type Mount,
  num,
  type Num,
  own,
  rect,
  type Writable,
} from "../../minim";

const W = 720;
const H = 460;
const BOX_SIZE = 56;
const Y0 = 120;

// Per-gap configuration.
//   h1 (A→B):  tight hard clamp.
//   v  (B↓C):  wider hard clamp — more room to stretch vertically.
//   h2 (C→D):  non-PG soft compress on the lower bound. Above `knee`,
//              the gap moves 1:1 with the drag. Below knee, the lens
//              REFUSES to fully shrink — writing target=30 gives slack
//              ≈ 60, with the unabsorbed residual flowing to C. Net
//              effect: pushing D into C feels squishy, with C visibly
//              giving way more as you approach the limit.
const H1_MIN = 30, H1_MAX = 110;
const V_MIN = 40, V_MAX = 200;
const H2_MIN = 30, H2_KNEE = 80, H2_K = 3, H2_MAX = 220;

/** Non-PG soft compress on the lower bound.
 *
 *  Above `knee`, the lens is identity: writes pass through 1:1 and
 *  `own()` doesn't engage the receiver. Below `knee`, the bwd
 *  REFUSES to fully shrink — writing target `t < knee` yields source
 *  `knee - (knee - t)/k`, which is much closer to `knee` than to `t`.
 *  The fwd is identity, so a write of `t` reads back as the compressed
 *  source value, not as `t`. This deliberate PG violation is the whole
 *  point: `own()`'s residual flow then pushes the receiver, so the
 *  unabsorbed motion becomes visible movement on the OTHER box.
 *
 *  Net feel: pushing D into C is squishy. As D approaches C, the gap
 *  resists shrinking, and C is dragged along — more and more as D gets
 *  closer. A hard `lo` floor is still enforced.
 */
function softCompressMin(
  src: Writable<Num>,
  lo: number,
  knee: number,
  k: number,
): Writable<Num> {
  return src.lens(
    v => v,
    target => {
      if (target >= knee) return target;
      const compressed = knee - (knee - target) / k;
      return Math.max(lo, compressed);
    },
  );
}

export class MdSlackChain extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const slack_h1 = num(80).clamp(H1_MIN, H1_MAX);
    const slack_v = num(80).clamp(V_MIN, V_MAX);
    const slack_h2 = softCompressMin(num(120).clamp(H2_MIN, H2_MAX), H2_MIN, H2_KNEE, H2_K);

    // Box A: free, draggable. The anchor of the chain.
    const boxA = s(
      rect(num(60), num(Y0), BOX_SIZE, BOX_SIZE, {
        fill: "#5b8def",
        stroke: "white",
        strokeWidth: 2,
        corner: 6,
      }),
    );

    // B.left = A.right + own(slack_h1). Standard symmetric drag-through
    // with a hard clamp.
    const bCenter = boxA.right.right(own(slack_h1)).right(BOX_SIZE / 2);
    const boxB = s(
      rect(bCenter, BOX_SIZE, BOX_SIZE, {
        fill: "#7ed321",
        stroke: "white",
        strokeWidth: 2,
        corner: 6,
      }),
    );

    // C.top = B.bottom + own(slack_v). Vertical link, wider clamp.
    const cCenter = boxB.bottom.down(own(slack_v)).down(BOX_SIZE / 2);
    const boxC = s(
      rect(cCenter, BOX_SIZE, BOX_SIZE, {
        fill: "#f5a623",
        stroke: "white",
        strokeWidth: 2,
        corner: 6,
      }),
    );

    // D.left = C.right + own(slack_h2). Horizontal link with soft-
    // compress gap. Pushing D toward C feels squishy: as the gap
    // approaches H2_KNEE, C is dragged along proportionally.
    const dCenter = boxC.right.right(own(slack_h2)).right(BOX_SIZE / 2);
    const boxD = s(
      rect(dCenter, BOX_SIZE, BOX_SIZE, {
        fill: "#e25c5c",
        stroke: "white",
        strokeWidth: 2,
        corner: 6,
      }),
    );

    drag(boxA, boxA.center);
    drag(boxB, bCenter);
    drag(boxC, cCenter);
    drag(boxD, dCenter);
    for (const b of [boxA, boxB, boxC, boxD]) b.el.style.cursor = "move";

    // Visualize each gap with a colored connector. The hue intensifies
    // when the slack is at (or near) a clamp boundary, so saturation is
    // legible at a glance.
    const atBoundH1 = derive(() => {
      const v = slack_h1.value;
      return v <= H1_MIN + 0.5 || v >= H1_MAX - 0.5;
    });
    const atBoundV = derive(() => {
      const v = slack_v.value;
      return v <= V_MIN + 0.5 || v >= V_MAX - 0.5;
    });
    // Soft-compress gap: highlight once we're inside the compressed
    // band below `H2_KNEE`, where pushing D feels squishy.
    const atBoundH2 = derive(() => {
      const v = slack_h2.value;
      return v <= H2_KNEE + 0.5 || v >= H2_MAX - 0.5;
    });

    s(
      line(boxA.right, boxB.left, {
        stroke: derive(() => (atBoundH1.value ? "#e25c5c" : "var(--text-color, #888)")),
        strokeWidth: derive(() => (atBoundH1.value ? 3 : 1.5)),
        cap: "round",
        opacity: 0.7,
      }),
      line(boxB.bottom, boxC.top, {
        stroke: derive(() => (atBoundV.value ? "#e25c5c" : "var(--text-color, #888)")),
        strokeWidth: derive(() => (atBoundV.value ? 3 : 1.5)),
        cap: "round",
        opacity: 0.7,
      }),
      line(boxC.right, boxD.left, {
        stroke: derive(() => (atBoundH2.value ? "#e25c5c" : "var(--text-color, #888)")),
        strokeWidth: derive(() => (atBoundH2.value ? 3 : 1.5)),
        cap: "round",
        opacity: 0.7,
      }),
    );

    s(
      label(
        view.top.down(16),
        "drag any of A B C D — chain propagates through three own()-clamped gaps",
        { size: 12, align: Anchor.Center },
      ),
      label(
        view.top.down(34),
        "h1: tight clamp · v: wide clamp · h2: soft compress (push D into C — squishy)",
        { size: 10, align: Anchor.Center, opacity: 0.7 },
      ),
      // Per-box letter labels
      label(boxA.center, "A", { fill: "white", bold: true, size: 16, align: Anchor.Center }),
      label(boxB.center, "B", { fill: "white", bold: true, size: 16, align: Anchor.Center }),
      label(boxC.center, "C", { fill: "white", bold: true, size: 16, align: Anchor.Center }),
      label(boxD.center, "D", { fill: "white", bold: true, size: 16, align: Anchor.Center }),
      // Per-gap readouts: show the slack value and its kind.
      label(
        boxA.top.lerp(boxB.top, 0.5).up(14),
        derive(() => `${slack_h1.value.toFixed(0)} ∈ [${H1_MIN}, ${H1_MAX}]`),
        {
          size: 10,
          align: Anchor.Center,
          fill: derive(() => (atBoundH1.value ? "#e25c5c" : "var(--text-color, #555)")),
        },
      ),
      label(
        boxB.bottom.lerp(boxC.top, 0.5).left(28),
        derive(() => `${slack_v.value.toFixed(0)} ∈ [${V_MIN}, ${V_MAX}]`),
        {
          size: 10,
          align: Anchor.Right,
          fill: derive(() => (atBoundV.value ? "#e25c5c" : "var(--text-color, #555)")),
        },
      ),
      label(
        boxC.top.lerp(boxD.top, 0.5).up(14),
        derive(() => `${slack_h2.value.toFixed(0)} (soft below ${H2_KNEE})`),
        {
          size: 10,
          align: Anchor.Center,
          fill: derive(() => (atBoundH2.value ? "#e25c5c" : "var(--text-color, #555)")),
        },
      ),
      label(
        view.bottom.up(8),
        "A → B   B ↓ C   C → D    each gap is own(num().clamp(...).variant)",
        { size: 10, align: Anchor.Center, opacity: 0.6 },
      ),
    );
  }
}
