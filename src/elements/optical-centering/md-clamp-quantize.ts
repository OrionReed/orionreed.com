// md-clamp-quantize.ts — `Num.clamp` and `Num.quantize` as projective
// lenses, chained. One source `t : Num`; each row reads its own lens
// in a single chain:
//
//   t
//   tC = t.clamp(lo, hi)        — projects to [lo, hi]
//   tQ = tC.quantize(0.1)       — snaps to the grid, inside the clamp
//
// Writes flow back through every prior lens. Dragging row 3 writes
// `tQ.value = cursor` → `tC.value = q(cursor)` → `t.value = c(q(cursor))`,
// so the source picks up both projections at once. Each row reads a
// different prefix of the chain — they all derive from one `t` but
// apply progressively more projection on the way out. Projection order
// matters: with `lo`/`hi` off-grid, the row-3 knob can land slightly
// outside `[lo, hi]` because `q` snaps the already-clamped value to
// the nearest detent.
//
// We drive each knob's x-axis through `range(X0, X1).slider(num)` and
// use `draggable` (not `drag`) so writes go straight to the x-slider —
// `vec(num, y_literal)` is forward-only by design.

import {
  Anchor,
  type AnyShape,
  circle,
  computed,
  Diagram,
  draggable,
  label,
  line,
  type Mount,
  type Num,
  num,
  range,
  rect,
  vec,
  type Writable,
} from "../../minim";

const W = 600;
const H = 240;
const X0 = 70;
const X1 = W - 70;
const SPAN = X1 - X0;
const ROWS = { raw: 70, clamp: 130, quant: 190 } as const;

export class MdClampQuantize extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const t = num(0.5);
    const lo = num(0.2);
    const hi = num(0.8);
    const tC = t.clamp(lo, hi);
    const tQ = tC.quantize(0.1);

    s(
      label(view.top.down(16), "chained projections — writes flow back through every prior lens", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
    );

    this.row(s, ROWS.raw, "t", t, "#5b8def", () => t.value.toFixed(3));

    // Clamp row: shaded margins flag the dead zones; pinch handles
    // ride the bound Nums and modify the clamp range as you drag.
    const loX = range(X0, X1).slider(lo);
    const hiX = range(X0, X1).slider(hi);
    const shade = { fill: "rgba(127,127,127,0.18)", stroke: "transparent" } as const;
    s(
      rect(
        X0,
        ROWS.clamp - 4,
        computed(() => loX.value - X0),
        8,
        shade,
      ),
      rect(
        hiX,
        ROWS.clamp - 4,
        computed(() => X1 - hiX.value),
        8,
        shade,
      ),
    );
    this.row(
      s,
      ROWS.clamp,
      "↳ .clamp(lo, hi)",
      tC,
      "#e25c5c",
      () => `[${lo.value.toFixed(2)}, ${hi.value.toFixed(2)}]`,
    );
    for (const pxX of [loX, hiX]) {
      const h = s(
        circle(vec(pxX, ROWS.clamp), 6, {
          fill: "white",
          stroke: "#888",
          strokeWidth: 1.5,
        }),
      );
      dragX(h, pxX);
    }

    // Tick detents; outside [lo, hi] they fade because the row-3 knob
    // can't reach them — the clamp upstream of `tQ` rejects writes
    // before quantize even gets to snap.
    for (let i = 0; i <= 10; i++) {
      const x = X0 + (i / 10) * SPAN;
      s(
        line(vec(x, ROWS.quant - 5), vec(x, ROWS.quant + 5), {
          thin: true,
          opacity: () => (i / 10 >= lo.value && i / 10 <= hi.value ? 0.45 : 0.12),
        }),
      );
    }
    this.row(s, ROWS.quant, "↳ .quantize(0.1)", tQ, "#7ed321", () => tQ.value.toFixed(1));

    s(
      label(
        view.bottom.up(10),
        "drag any rail — writes propagate up the chain through each prior projection",
        { size: 9.5, align: Anchor.Center, opacity: 0.5 },
      ),
    );
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
      label(vec(X0, y - 16), name, { size: 11, align: Anchor.Left, opacity: 0.6 }),
      label(vec(X1, y - 16), computed(readout), {
        size: 11,
        align: Anchor.Right,
        opacity: 0.6,
      }),
      line(vec(X0, y), vec(X1, y), { thin: true, opacity: 0.35, cap: "round" }),
    );
    const sliderX = range(X0, X1).slider(t);
    const knob = s(circle(vec(sliderX, y), 9, { fill: color, stroke: "white", strokeWidth: 2 }));
    dragX(knob, sliderX);
  }
}

/** Horizontal drag that writes only to `x` — `vec(x, y_literal)` is
 *  forward-only, so the bidirectional `drag(shape, vec)` shape doesn't
 *  apply here. We track the grab offset in the shape's local frame so
 *  click-anywhere-on-the-knob doesn't teleport. */
function dragX(shape: AnyShape, x: Writable<Num>): void {
  let grabDx = 0;
  shape.on("pointerdown", e => {
    const local = shape.toLocal(e as PointerEvent);
    grabDx = local.x - x.value;
  });
  draggable(shape, local => {
    x.value = local.x - grabDx;
  });
  shape.el.style.cursor = "ew-resize";
}
