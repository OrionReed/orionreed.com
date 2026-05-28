// md-adaptive-clamp.ts — `clamp` with writable bounds via `share()`.
//
// Three rows on the same source `t`:
//
//   row 1 — t                                  raw cell, no constraints
//   row 2 — t.clamp(lo, hi)                    classic clamp: projects writes
//   row 3 — t.clamp(share(lo), share(hi))      bounds STRETCH to admit overflows
//
// Drag the row-2 knob past a bound and the knob sticks at the bound
// (classic projection — the bound rejects). Drag the row-3 knob past a
// bound and the bound MOVES to admit it (wp-promotion via `share()` —
// the bound is now a handle that absorbs).
//
// Same `clamp` method, same value classes, same engine. The only
// difference is wrapping the bound cells in `share()` at the call site.

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
  rect,
  share,
  vec,
  type Writable,
} from "../../minim";

const W = 640;
const H = 260;
const X0 = 70;
const X1 = W - 70;
const SPAN = X1 - X0;
const ROWS = { raw: 70, classic: 140, adaptive: 210 } as const;

export class MdAdaptiveClamp extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    // One source, two clamp variants — classic projection vs adaptive.
    const t = num(0.5);
    const loC = num(0.25); // classic bounds
    const hiC = num(0.75);
    const loA = num(0.25); // adaptive bounds (wrapped)
    const hiA = num(0.75);

    const tClassic = t.clamp(loC, hiC);
    const tAdaptive = t.clamp(share(loA), share(hiA));

    s(
      label(
        view.top.down(16),
        "drag the bottom knob past a bound — the bound stretches to admit it",
      ),
    );

    this.row(s, ROWS.raw, "t", t, "#5b8def", () => t.value.toFixed(2));
    this.shaded(s, ROWS.classic, loC, hiC);
    this.row(s, ROWS.classic, "↳ .clamp(lo, hi)", tClassic, "#e25c5c", () =>
      `[${loC.value.toFixed(2)}, ${hiC.value.toFixed(2)}]`,
    );
    this.shaded(s, ROWS.adaptive, loA, hiA);
    this.row(s, ROWS.adaptive, "↳ .clamp(share(lo), share(hi))", tAdaptive, "#7ed321", () =>
      `[${loA.value.toFixed(2)}, ${hiA.value.toFixed(2)}]`,
    );
    // Render explicit pinch-handles on both clamp rows for the bounds.
    this.bounds(s, ROWS.classic, loC, hiC, "#e25c5c");
    this.bounds(s, ROWS.adaptive, loA, hiA, "#7ed321");

    s(
      label(
        view.bottom.up(10),
        "row 2: classic clamp (writes project back) · row 3: wp-clamp (bounds absorb on overrun)",
        { size: 9.5 },
      ),
    );
  }

  /** Faded margins outside [lo, hi] to indicate the dead zones. */
  private shaded(s: Mount, y: number, lo: Writable<Num>, hi: Writable<Num>): void {
    const loX = derive(() => X0 + lo.value * SPAN);
    const hiX = derive(() => X0 + hi.value * SPAN);
    const shade = { fill: "rgba(127,127,127,0.18)", stroke: "transparent" } as const;
    s(
      rect(
        X0,
        y - 5,
        derive(() => loX.value - X0),
        10,
        shade,
      ),
      rect(
        hiX,
        y - 5,
        derive(() => X1 - hiX.value),
        10,
        shade,
      ),
    );
  }

  /** Draggable bound handles. Drag a bound to move it directly. */
  private bounds(
    s: Mount,
    y: number,
    lo: Writable<Num>,
    hi: Writable<Num>,
    color: string,
  ): void {
    for (const t of [lo, hi]) {
      const pos = vec(range(X0, X1).slider(t), Num.pin(y));
      const h = s(circle(pos, 6, { fill: "white", stroke: color, strokeWidth: 2 }));
      drag(h, pos);
      h.el.style.cursor = "ew-resize";
    }
  }

  private row(
    s: Mount,
    y: number,
    name: string,
    t: Writable<Num>,
    color: string,
    readout: () => string,
  ): void {
    s(
      label(vec(X0, y - 16), name, { align: Anchor.Left }),
      label(vec(X1, y - 16), derive(readout), { align: Anchor.Right }),
      line(vec(X0, y), vec(X1, y), { thin: true, opacity: 0.35, cap: "round" }),
    );
    const pos = vec(range(X0, X1).slider(t), Num.pin(y));
    const knob = s(circle(pos, 9, { fill: color, stroke: "white", strokeWidth: 2 }));
    drag(knob, pos);
    knob.el.style.cursor = "ew-resize";
  }
}
