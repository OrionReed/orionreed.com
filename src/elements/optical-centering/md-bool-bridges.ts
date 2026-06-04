// md-bool-bridges.ts — six Bool-bridging lenses across continuous and
// discrete value types. Each mini-demo exposes a writable `Bool` that's
// the projection of one or more source signals; clicking the indicator
// flips the bool and the lens's bwd projects the source(s) into a
// state consistent with the new boolean.
//
// The six panels cover distinct lens shapes that all flow through the
// same `Bool.lens(parents, fwd, bwd)` primitive:
//
//   1. Point in box        — Vec → Bool         (spatial clamp)
//   2. Slider above        — Num → Bool         (scalar clamp)
//   3. Two points coincide — (Vec, Vec) → Bool  (equality relation)
//   4. All N inside        — Array<Vec> → Bool  (aggregate fan-in)
//   5. Even                — Num → Bool         (discrete classifier)
//   6. Boxes overlap       — (Box, Box) → Bool  (collision relation)
//
// (1) and (2) are the clamp family (idempotent projection across the
// type boundary). (3) and (6) are TWO-source relations whose bwd reshapes
// a parent (coincidence; min-translation collision resolve). (4) is
// N-aggregate — one bool over many sources. (5) is a discrete classifier
// over an integer-quantised slider.

import {
  Anchor,
  Bool,
  box,
  type Cell,
  Diagram,
  derive,
  group,
  handle,
  label,
  line,
  type Mount,
  num,
  rect,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const W = 860;
const H = 250;

type V = { x: number; y: number };
type BoxV = { x: number; y: number; w: number; h: number };

// ─── Geometry helpers ────────────────────────────────────────────

const isInside = (p: V, b: BoxV): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

const clampInto = (p: V, b: BoxV, eps = 6): V => ({
  x: Math.max(b.x + eps, Math.min(b.x + b.w - eps, p.x)),
  y: Math.max(b.y + eps, Math.min(b.y + b.h - eps, p.y)),
});

const ejectOut = (p: V, b: BoxV, eps = 6): V => {
  if (!isInside(p, b)) return p;
  const distLeft = p.x - b.x;
  const distRight = b.x + b.w - p.x;
  const distTop = p.y - b.y;
  const distBot = b.y + b.h - p.y;
  const min = Math.min(distLeft, distRight, distTop, distBot);
  if (min === distLeft) return { x: b.x - eps, y: p.y };
  if (min === distRight) return { x: b.x + b.w + eps, y: p.y };
  if (min === distTop) return { x: p.x, y: b.y - eps };
  return { x: p.x, y: b.y + b.h + eps };
};

// ─── Indicator ───────────────────────────────────────────────────

const TRUE_FILL = "#5b8def";
const FALSE_FILL = "#d8dde6";
const IND_W = 90;
const IND_H = 22;

/** Pill-shaped clickable indicator. Click toggles the underlying bool;
 *  reads track via effects so the pill colour and label content change
 *  reactively. */
function boolIndicator(
  s: Mount,
  cx: number,
  cy: number,
  b: Writable<Bool>,
  trueLabel: string,
  falseLabel: string,
): void {
  const g = group(
    { translate: vec(cx - IND_W / 2, cy - IND_H / 2) },
    rect(0, 0, IND_W, IND_H, {
      corner: 11,
      fill: derive(() => (b.value ? TRUE_FILL : FALSE_FILL)),
      stroke: "#666",
      thin: true,
    }),
    label(
      vec(IND_W / 2, IND_H / 2),
      derive(() => (b.value ? trueLabel : falseLabel)),
      {
        size: 11,
        bold: true,
        align: Anchor.Center,
        fill: derive(() => (b.value ? "#fff" : "#333")),
      },
    ),
  );
  g.el.style.cursor = "pointer";
  g.on("click", () => {
    b.value = !b.peek();
  });
  s(g);
}

// ─── The diagram ─────────────────────────────────────────────────

export class MdBoolBridges extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const CELL_W = 140;
    const cellCx = (i: number) => 10 + CELL_W * i + CELL_W / 2;
    const CANVAS_Y = 50;
    const IND_Y = 175;
    const LABEL_Y = 205;

    s(
      label(
        view.top.down(18),
        "Bool bridges: a continuous source projected through a boolean predicate",
      ),
      label(
        view.bottom.up(12),
        "click any indicator — the lens's bwd flips the source into the requested state",
        {
          size: 10,
        },
      ),
    );

    // ─── Demo 1: Point in box (Vec → Bool) ────────────────────
    {
      const cx = cellCx(0);
      const box1 = box(cx - 35, CANVAS_Y + 20, 70, 60);
      const p1 = vec(cx, CANVAS_Y + 50);
      const inBox = box1.contains(p1);
      s(
        rect(box1, {
          thin: true,
          fill: "rgba(91,141,239,0.10)",
          stroke: "#5b8def",
        }),
        handle(p1, { fill: "#222", r: 6 }),
      );
      boolIndicator(s, cx, IND_Y, inBox, "inside", "outside");
      s(label(vec(cx, LABEL_Y), "Box#contains(Vec)", { size: 10, opacity: 0.6 }));
    }

    // ─── Demo 2: Slider above threshold (Num → Bool) ──────────
    {
      const cx = cellCx(1);
      const trackX0 = cx - 50;
      const trackX1 = cx + 50;
      const trackY = CANVAS_Y + 60;
      const threshold = 0.5;
      const t2 = num(0.7);
      const above = t2.greaterThan(threshold, 0.06);
      const knobX = t2.clamp(0, 1).affine(trackX1 - trackX0, trackX0);
      const knobPos = Vec.lens(
        [knobX] as const,
        ([x]) => ({ x, y: trackY }),
        p => [p.x],
      );
      // Threshold tick + shaded "above" band.
      const tx = trackX0 + threshold * (trackX1 - trackX0);
      s(
        rect(trackX0, trackY - 4, tx - trackX0, 8, {
          fill: "rgba(220,220,220,0.5)",
          stroke: "transparent",
        }),
        rect(tx, trackY - 4, trackX1 - tx, 8, {
          fill: "rgba(91,141,239,0.18)",
          stroke: "transparent",
        }),
        line(vec(trackX0, trackY), vec(trackX1, trackY), { thin: true, opacity: 0.4 }),
        line(vec(tx, trackY - 12), vec(tx, trackY + 12), { thin: true, opacity: 0.6 }),
        label(vec(tx, trackY - 18), `${threshold}`, { size: 9, opacity: 0.6 }),
        handle(knobPos, { fill: "#222", r: 6 }),
      );
      boolIndicator(s, cx, IND_Y, above, "above", "below");
      s(label(vec(cx, LABEL_Y), "Num#greaterThan", { size: 10, opacity: 0.6 }));
    }

    // ─── Demo 3: Two points coincide ───────────────────────────
    {
      const cx = cellCx(2);
      const cy = CANVAS_Y + 50;
      const a3 = vec(cx - 25, cy);
      const b3 = vec(cx + 25, cy);
      const COINCIDE_R = 10;
      const coincide = Bool.lens(
        [a3, b3] as const,
        ([va, vb]) => Math.hypot(va.x - vb.x, va.y - vb.y) < COINCIDE_R,
        (target, [va, vb]) => {
          const dist = Math.hypot(va.x - vb.x, va.y - vb.y);
          if (target) {
            if (dist < COINCIDE_R) return [va, vb];
            const mid = { x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2 };
            return [mid, mid];
          }
          if (dist >= COINCIDE_R) return [va, vb];
          const mid = { x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2 };
          return [
            { x: mid.x - 25, y: mid.y },
            { x: mid.x + 25, y: mid.y },
          ];
        },
      );
      // Connector line; opacity scales with how close to coincident.
      const connectorOpacity = derive(() => {
        const va = a3.value;
        const vb = b3.value;
        const d = Math.hypot(va.x - vb.x, va.y - vb.y);
        return Math.max(0.15, Math.min(1, 1 - d / 80));
      });
      s(
        line(a3, b3, { thin: true, opacity: connectorOpacity, stroke: "#f5a623" }),
        handle(a3, { fill: "#f5a623", r: 7 }),
        handle(b3, { fill: "#e07d0a", r: 7 }),
      );
      boolIndicator(s, cx, IND_Y, coincide, "same", "apart");
      s(label(vec(cx, LABEL_Y), "(Vec, Vec) → Bool", { size: 10, opacity: 0.6 }));
    }

    // ─── Demo 4: All N inside ──────────────────────────────────
    {
      const cx = cellCx(3);
      const box4: BoxV = { x: cx - 40, y: CANVAS_Y + 20, w: 80, h: 60 };
      const points = [
        vec(cx - 20, CANVAS_Y + 40),
        vec(cx + 20, CANVAS_Y + 70),
        vec(cx, CANVAS_Y + 55),
      ];
      const allIn = Bool.lens(
        points,
        ps => ps.every(p => isInside(p, box4)),
        (target, ps) => {
          if (target) {
            return ps.map(p => (isInside(p, box4) ? p : clampInto(p, box4)));
          }
          return ps.map(p => (!isInside(p, box4) ? p : ejectOut(p, box4)));
        },
      );
      s(
        rect(box4.x, box4.y, box4.w, box4.h, {
          thin: true,
          fill: "rgba(91,141,239,0.10)",
          stroke: "#5b8def",
        }),
        ...points.map(p => handle(p, { fill: "#222", r: 5 })),
      );
      boolIndicator(s, cx, IND_Y, allIn, "all in", "some out");
      s(label(vec(cx, LABEL_Y), "Array<Vec> → Bool", { size: 10, opacity: 0.6 }));
    }

    // ─── Demo 5: Even (Num → Bool, discrete classifier) ────────
    {
      const cx = cellCx(4);
      const trackX0 = cx - 50;
      const trackX1 = cx + 50;
      const trackY = CANVAS_Y + 60;
      const NMAX = 10;
      const n5 = num(4);
      const snapped = n5.clamp(0, NMAX).quantize(1);
      const even = snapped.isEven;
      const knobX = snapped.affine((trackX1 - trackX0) / NMAX, trackX0);
      const knobPos = Vec.lens(
        [knobX] as const,
        ([x]) => ({ x, y: trackY }),
        p => [p.x],
      );
      // Tick marks at each integer, larger/coloured at even positions.
      const ticks = Array.from({ length: NMAX + 1 }, (_, i) => {
        const x = trackX0 + (i / NMAX) * (trackX1 - trackX0);
        const isEven = i % 2 === 0;
        return line(vec(x, trackY - (isEven ? 6 : 4)), vec(x, trackY + (isEven ? 6 : 4)), {
          thin: true,
          opacity: isEven ? 0.6 : 0.3,
          stroke: isEven ? "#5b8def" : undefined,
        });
      });
      // Readout above the slider.
      const readout: Cell<string> = derive(() => `n = ${Math.round(snapped.value)}`);
      s(
        line(vec(trackX0, trackY), vec(trackX1, trackY), { thin: true, opacity: 0.4 }),
        ...ticks,
        label(vec(cx, trackY - 22), readout, { size: 10, opacity: 0.7 }),
        handle(knobPos, { fill: "#222", r: 6 }),
      );
      boolIndicator(s, cx, IND_Y, even, "even", "odd");
      s(label(vec(cx, LABEL_Y), "Num#isEven", { size: 10, opacity: 0.6 }));
    }

    // ─── Demo 6: Boxes overlap ((Box, Box) → Bool) ─────────────
    {
      const cx = cellCx(5);
      const HW = 16;
      const HH = 13;
      const EPS = 1;
      const a6 = vec(cx - 14, CANVAS_Y + 42);
      const b6 = vec(cx + 16, CANVAS_Y + 56);
      const overlapping = (pa: V, pb: V) =>
        Math.abs(pa.x - pb.x) < 2 * HW && Math.abs(pa.y - pb.y) < 2 * HH;
      const overlap = Bool.lens(
        [a6, b6] as const,
        ([pa, pb]) => overlapping(pa, pb),
        (target, [pa, pb]) => {
          if (overlapping(pa, pb) === target) return [undefined, undefined];
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          if (target) {
            // Pull B in: clamp each axis so the boxes overlap minimally.
            const nx = Math.abs(dx) >= 2 * HW ? pa.x + Math.sign(dx || 1) * (2 * HW - EPS) : pb.x;
            const ny = Math.abs(dy) >= 2 * HH ? pa.y + Math.sign(dy || 1) * (2 * HH - EPS) : pb.y;
            return [undefined, { x: nx, y: ny }];
          }
          // Push B out along the min-penetration axis.
          const penX = 2 * HW - Math.abs(dx);
          const penY = 2 * HH - Math.abs(dy);
          if (penX <= penY) {
            return [undefined, { x: pa.x + Math.sign(dx || 1) * (2 * HW + EPS), y: pb.y }];
          }
          return [undefined, { x: pb.x, y: pa.y + Math.sign(dy || 1) * (2 * HH + EPS) }];
        },
      );
      const boxRect = (c: typeof a6, fill: string, stroke: string) =>
        rect(c, 2 * HW, 2 * HH, { thin: true, fill, stroke, corner: 3 });
      s(
        boxRect(a6, "rgba(91,141,239,0.16)", "#5b8def"),
        boxRect(b6, "rgba(245,166,35,0.18)", "#f5a623"),
        handle(a6, { fill: "#5b8def", r: 6 }),
        handle(b6, { fill: "#e07d0a", r: 6 }),
      );
      boolIndicator(s, cx, IND_Y, overlap, "overlap", "disjoint");
      s(label(vec(cx, LABEL_Y), "(Box, Box) → Bool", { size: 10, opacity: 0.6 }));
    }
  }
}
