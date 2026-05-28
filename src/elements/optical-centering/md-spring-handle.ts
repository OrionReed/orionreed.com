// md-spring-handle.ts — reactive split policy via `share(slack, {weight: stiffness})`.
//
// Two cells coupled by a writable offset: anchor A and slack n. The
// handle B = A.right(share(n, {weight: stiffness})). Drag B; depending on
// stiffness, A absorbs (rigid coupling) or n absorbs (loose handle).
//
// Stiffness itself is a Num signal — drag the top slider to re-aim the
// bwd's split policy LIVE. Same lens cell, no rebuild. This is the
// canonical "rules as data" demo: the lens's behavior interpolates
// continuously as you drag a slider that controls the bwd.

import {
  Anchor,
  circle,
  derive,
  Diagram,
  drag,
  label,
  line,
  type Mount,
  Num,
  num,
  range,
  share,
  Vec,
  vec,
} from "../../minim";

const W = 640;
const H = 280;
const Y_SLIDER = 50;
const Y_PLAY = 170;
const X0 = 90;
const X1 = W - 90;
const SPAN = X1 - X0;

export class MdSpringHandle extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    // Anchor A at fixed-y, draggable in x.
    const aX = num(180);
    const A = vec(aX, Num.pin(Y_PLAY));
    // Slack n: offset distance.
    const n = num(80);
    // Reactive stiffness: 0 = rigid coupling (A absorbs), 1 = loose handle (n absorbs).
    const stiffness = num(1);
    // Handle B = A + n along x, with absorption split by stiffness.
    const B = A.right(share(n, { weight: stiffness }));

    s(label(view.top.down(14), "drag B → split between A and n absorbs delta · slider controls split"));

    // ─── Stiffness slider ───────────────────────────────────────────
    s(
      label(vec(X0, Y_SLIDER - 18), "stiffness", { align: Anchor.Left, size: 11 }),
      label(
        vec(X1, Y_SLIDER - 18),
        derive(() => `${stiffness.value.toFixed(2)}   ←  ${absorbLabel(stiffness.value)}`),
        { align: Anchor.Right, size: 11 },
      ),
      line(vec(X0, Y_SLIDER), vec(X1, Y_SLIDER), { thin: true, opacity: 0.35, cap: "round" }),
    );
    // Stiffness tick marks at 0 and 1
    for (let i = 0; i <= 4; i++) {
      const x = X0 + (i / 4) * SPAN;
      s(line(vec(x, Y_SLIDER - 4), vec(x, Y_SLIDER + 4), { thin: true, opacity: 0.3 }));
    }
    const stiffnessPos = vec(range(X0, X1).slider(stiffness), Num.pin(Y_SLIDER));
    const stiffnessKnob = s(
      circle(stiffnessPos, 9, { fill: "#7ed321", stroke: "white", strokeWidth: 2 }),
    );
    drag(stiffnessKnob, stiffnessPos);
    stiffnessKnob.el.style.cursor = "ew-resize";

    // ─── Anchor / handle play area ────────────────────────────────
    s(line(vec(X0, Y_PLAY), vec(X1, Y_PLAY), { thin: true, opacity: 0.3, cap: "round" }));

    // Visual coupling between A and B as a line, with thickness scaling
    // with stiffness (rigid = thick line; loose = thin/spring-like).
    s(
      line(A, B, {
        stroke: derive(() => mixColor(stiffness.value, "#ff7043", "#bcd9e8")),
        strokeWidth: derive(() => 2 + (1 - stiffness.value) * 5), // rigid = thicker
        cap: "round",
        opacity: 0.7,
      }),
    );

    // Anchor A: draggable
    const aKnob = s(
      circle(A, 10, { fill: "#5b8def", stroke: "white", strokeWidth: 2 }),
    );
    drag(aKnob, A);
    aKnob.el.style.cursor = "move";
    s(label(A.up(22), "A (anchor)", { size: 11, align: Anchor.Center, fill: "#5b8def" }));

    // Handle B: draggable, displays slack value
    const bKnob = s(
      circle(B, 10, { fill: "#e25c5c", stroke: "white", strokeWidth: 2 }),
    );
    drag(bKnob, B);
    bKnob.el.style.cursor = "move";
    s(label(B.down(22), "B (handle)", { size: 11, align: Anchor.Center, fill: "#e25c5c" }));

    // Slack readout above the midpoint
    const midPos = Vec.derive(() => ({
      x: (A.value.x + B.value.x) / 2,
      y: Y_PLAY - 16,
    }));
    s(
      label(
        midPos,
        derive(() => `n = ${n.value.toFixed(0)} px`),
        { size: 10.5, align: Anchor.Center, fill: "var(--text-color, #333)", opacity: 0.85 },
      ),
    );

    s(
      label(
        view.bottom.up(10),
        "stiffness=0 → A absorbs (rigid)  ·  stiffness=1 → n absorbs (loose)  ·  in between → split",
        { size: 9.5 },
      ),
    );
  }
}

function absorbLabel(s: number): string {
  if (s <= 0.05) return "A absorbs all";
  if (s >= 0.95) return "n absorbs all";
  const pct = Math.round(s * 100);
  return `n: ${pct}%, A: ${100 - pct}%`;
}

function mixColor(t: number, c0: string, c1: string): string {
  const pct = Math.round(t * 100);
  return `color-mix(in srgb, ${c0} ${100 - pct}%, ${c1} ${pct}%)`;
}
