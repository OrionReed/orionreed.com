// md-select.ts — `select` and `crossfade` are ONE lens (`mix`), differing
// only in where the control sits on the weight simplex.
//
//   Bool × ⟨A, B⟩ → A   select    — control at a simplex VERTEX (snaps)
//   Num  × ⟨A, B⟩ → A   crossfade — control on a simplex EDGE   (blends)
//
// Two pairs of animated shapes. Each shape carries three channels —
// position (Vec), fill (Color), radius (Num) — and every channel flows
// through the same trait-dispatched `mix`, so the crossfade is a genuine
// multi-DoF blend, not a single slider. The bwd splits a write by the
// min-norm policy `daᵢ = wᵢ·δ / Σwⱼ²`; at a vertex that's "all to the live
// branch", which is why toggling snaps to the other branch's value.

import {
  Anchor,
  type Bool,
  bool,
  type Color,
  circle,
  crossfade,
  Diagram,
  derive,
  group,
  handle,
  label,
  line,
  type Mount,
  type Num,
  num,
  rect,
  rgb,
  select,
  Vec,
  vec,
  type Writable,
  wave,
} from "../../minim";

const W = 720;
const H = 320;

const BLUE = "#5b8def";
const ORANGE = "#e8833a";

type Src = { pos: Writable<Vec>; col: Writable<Color>; r: Writable<Num> };

export class MdSelect extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    s(
      label(view.top.down(18), "select and crossfade are one lens — mix(weights, branches)"),
      label(
        view.bottom.up(12),
        "the control is a point on the weight simplex: a Bool vertex snaps; a Num edge blends position, colour and size at once",
        { size: 10 },
      ),
    );

    const PX = 230;
    const rowY = (i: number) => 95 + i * 120;

    // A pair of animated sources around a centre: A orbits a circle, B
    // traces a lissajous, on contrasting paths so the blend is legible.
    const pair = (cy: number): { a: Src; b: Src } => {
      const a: Src = { pos: vec(PX, cy), col: rgb(0.36, 0.56, 0.94), r: num(13) };
      const b: Src = { pos: vec(PX, cy), col: rgb(0.91, 0.51, 0.23), r: num(8) };
      this.anim.start(
        wave(a.pos, t => ({ x: PX + 78 * Math.cos(1.1 * t), y: cy + 40 * Math.sin(1.1 * t) })),
      );
      this.anim.start(
        wave(b.pos, t => ({
          x: PX + 66 * Math.sin(1.7 * t),
          y: cy + 42 * Math.sin(0.9 * t + 0.6),
        })),
      );
      return { a, b };
    };

    const stage = (cy: number) =>
      rect(58, cy - 58, 366, 116, {
        fill: "rgba(127,127,127,0.05)",
        stroke: "rgba(127,127,127,0.18)",
        corner: 10,
        thin: true,
      });
    const ghost = (sr: Src, color: string) =>
      circle(sr.pos, sr.r, { fill: color, opacity: 0.3, stroke: "transparent" });
    const output = (pos: Writable<Vec>, col: Writable<Color>, r: Writable<Num>) =>
      circle(pos, r, { fill: col.css, stroke: "#222", strokeWidth: 2 });

    // ─── Row 0: Bool select (vertex / snap) ──────────────────────────
    {
      const cy = rowY(0);
      const { a, b } = pair(cy);
      const cond = bool(false); // false → A, true → B
      s(
        stage(cy),
        ghost(a, BLUE),
        ghost(b, ORANGE),
        output(select(cond, a.pos, b.pos), select(cond, a.col, b.col), select(cond, a.r, b.r)),
      );
      toggle(s, 560, cy, cond, "following B", "following A");
      s(
        label(vec(560, cy + 38), "select(cond, A, B)", { size: 10, opacity: 0.6 }),
        label(vec(560, cy + 52), "Bool → simplex vertex", { size: 9, opacity: 0.45 }),
      );
    }

    // ─── Row 1: Num crossfade (edge / blend) ─────────────────────────
    {
      const cy = rowY(1);
      const { a, b } = pair(cy);
      const t = num(0.5);
      s(
        stage(cy),
        ghost(a, BLUE),
        ghost(b, ORANGE),
        output(crossfade(t, a.pos, b.pos), crossfade(t, a.col, b.col), crossfade(t, a.r, b.r)),
      );
      slider(s, 500, 648, cy, t);
      s(
        label(vec(574, cy + 38), "crossfade(t, A, B)", { size: 10, opacity: 0.6 }),
        label(vec(574, cy + 52), "Num → simplex edge", { size: 9, opacity: 0.45 }),
      );
    }
  }
}

/** Clickable pill that flips a writable Bool. */
function toggle(
  s: Mount,
  cx: number,
  cy: number,
  b: Writable<Bool>,
  trueLabel: string,
  falseLabel: string,
): void {
  const w = 116;
  const h = 24;
  const g = group(
    { translate: vec(cx - w / 2, cy - h / 2) },
    rect(0, 0, w, h, {
      corner: 12,
      fill: derive(() => (b.value ? ORANGE : BLUE)),
      stroke: "#444",
      thin: true,
    }),
    label(
      vec(w / 2, h / 2),
      derive(() => (b.value ? trueLabel : falseLabel)),
      {
        size: 11,
        bold: true,
        align: Anchor.Center,
        fill: "#fff",
      },
    ),
  );
  g.el.style.cursor = "pointer";
  g.on("click", () => {
    b.value = !b.peek();
  });
  s(g);
}

/** Drag slider over [0, 1] writing a Num via a Vec.lens-backed handle. */
function slider(s: Mount, x0: number, x1: number, y: number, t: Writable<Num>): void {
  const knobPos = Vec.lens(
    [t] as const,
    ([tv]) => ({ x: x0 + tv * (x1 - x0), y }),
    p => [Math.max(0, Math.min(1, (p.x - x0) / (x1 - x0)))],
  );
  s(
    line(vec(x0, y), vec(x1, y), { thin: true, opacity: 0.4 }),
    label(
      vec((x0 + x1) / 2, y - 16),
      derive(() => `t = ${t.value.toFixed(2)}`),
      {
        size: 10,
        opacity: 0.7,
      },
    ),
    handle(knobPos, { fill: "#222", r: 7 }),
  );
}
