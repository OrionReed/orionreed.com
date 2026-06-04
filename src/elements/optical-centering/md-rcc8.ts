// md-rcc8.ts — `(Box, Box) → RCC-8`.
//
// The 2D sibling of `md-allen`. Two axis-aligned rectangles (eight
// continuous DOF) collapse to ONE of the eight Region-Connection-
// Calculus relations: disconnected, externally connected, partially
// overlapping, the two proper-part pairs (tangential / non-tangential,
// each direction), and equal. Read = classify; write a chip = reshape
// B into a canonical realization against the fixed A.
//
// Built on a local `Rcc extends Cell<Rel>` so the relation is a real
// writable cell: `Rcc.lens([A, B], classify, realize)`. Drag/resize the
// boxes, the active chip tracks; click a chip, B rearranges.

import {
  Anchor,
  type Box,
  box,
  Cell,
  Diagram,
  derive,
  drag,
  group,
  handle,
  label,
  type Mount,
  rect,
  Vec,
  vec,
} from "../../minim";

const W = 720;
const H = 340;

// The eight RCC-8 relations, paired with their inverse across `EQ`.
const RELATIONS = [
  { code: "DC", name: "disconnected" },
  { code: "EC", name: "externally connected" },
  { code: "PO", name: "partially overlapping" },
  { code: "TPP", name: "tangential part of B" },
  { code: "NTPP", name: "non-tangential part of B" },
  { code: "EQ", name: "equal" },
  { code: "TPPi", name: "tangential, B part of A" },
  { code: "NTPPi", name: "non-tangential, B part of A" },
] as const;
type Rel = (typeof RELATIONS)[number]["code"];

const nameOf = (code: Rel) => RELATIONS.find(r => r.code === code)!.name;

const equals = (a: Rel, b: Rel) => a === b;

class Rcc extends Cell<Rel> {
  static traits = { equals };
  declare readonly _t: typeof Rcc.traits;
  constructor(v: Rel = "EQ") {
    super(v, { equals });
  }
}

type BoxV = { x: number; y: number; w: number; h: number };

/** Classify A relative to B, with `eps` slack on boundary coincidence. */
function classify(a: BoxV, b: BoxV, eps: number): Rel {
  const ax0 = a.x;
  const ax1 = a.x + a.w;
  const ay0 = a.y;
  const ay1 = a.y + a.h;
  const bx0 = b.x;
  const bx1 = b.x + b.w;
  const by0 = b.y;
  const by1 = b.y + b.h;
  const near = (x: number, y: number) => Math.abs(x - y) <= eps;

  // Overlap extent per axis: negative ⇒ a gap on that axis.
  const ox = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  const oy = Math.min(ay1, by1) - Math.max(ay0, by0);

  if (ox < -eps || oy < -eps) return "DC";
  // Closures meet but interiors don't (touch on one axis).
  if (ox <= eps || oy <= eps) return "EC";

  const aInB = ax0 >= bx0 - eps && ax1 <= bx1 + eps && ay0 >= by0 - eps && ay1 <= by1 + eps;
  const bInA = bx0 >= ax0 - eps && bx1 <= ax1 + eps && by0 >= ay0 - eps && by1 <= ay1 + eps;

  if (aInB && bInA) return "EQ";
  if (aInB) {
    const touch = near(ax0, bx0) || near(ax1, bx1) || near(ay0, by0) || near(ay1, by1);
    return touch ? "TPP" : "NTPP";
  }
  if (bInA) {
    const touch = near(bx0, ax0) || near(bx1, ax1) || near(by0, ay0) || near(by1, ay1);
    return touch ? "TPPi" : "NTPPi";
  }
  return "PO";
}

/** Canonical B-placement realizing `rel` against fixed A. Keeps B's size
 *  for the disjoint/overlap relations; sizes B to fit for the part-of
 *  relations. */
function realize(rel: Rel, a: BoxV, b: BoxV): BoxV {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bw = b.w;
  const bh = b.h;
  const gap = Math.max(18, a.w * 0.4);
  const m = Math.max(14, Math.min(a.w, a.h) * 0.3);
  const mk = (x: number, y: number, w: number, h: number): BoxV => ({ x, y, w, h });
  switch (rel) {
    case "DC":
      return mk(a.x + a.w + gap, acy - bh / 2, bw, bh);
    case "EC":
      return mk(a.x + a.w, acy - bh / 2, bw, bh);
    case "PO":
      return mk(a.x + a.w - bw / 2, a.y + a.h - bh / 2, bw, bh);
    case "TPP":
      return mk(a.x, a.y - m, a.w + m, a.h + 2 * m);
    case "NTPP":
      return mk(a.x - m, a.y - m, a.w + 2 * m, a.h + 2 * m);
    case "EQ":
      return mk(a.x, a.y, a.w, a.h);
    case "TPPi":
      return mk(a.x, acy - (a.h * 0.6) / 2, a.w * 0.5, a.h * 0.6);
    case "NTPPi":
      return mk(acx - (a.w * 0.45) / 2, acy - (a.h * 0.45) / 2, a.w * 0.45, a.h * 0.45);
  }
}

export class MdRcc8 extends Diagram {
  static styles = `text { pointer-events: none; }`;
  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const EPS = 2.5;
    const MIN = 26;

    const A = box(150, 70, 130, 90);
    const B = box(330, 95, 110, 70);

    const rel = Rcc.lens(
      [A, B] as const,
      ([a, b]) => classify(a, b, EPS),
      (target, [a, b]) => [undefined, realize(target, a, b)],
    );

    // Body-drag to move + corner-resize handle.
    const drawBox = (Bx: Box, fill: string, stroke: string, labelText: string) => {
      const center = Vec.lens(
        [Bx] as const,
        ([b]) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }),
        (p, [b]) => [{ x: p.x - b.w / 2, y: p.y - b.h / 2, w: b.w, h: b.h }],
      );
      const corner = Vec.lens(
        [Bx] as const,
        ([b]) => ({ x: b.x + b.w, y: b.y + b.h }),
        (p, [b]) => [{ x: b.x, y: b.y, w: Math.max(MIN, p.x - b.x), h: Math.max(MIN, p.y - b.y) }],
      );
      const body = rect(
        derive(() => Bx.value.x),
        derive(() => Bx.value.y),
        derive(() => Bx.value.w),
        derive(() => Bx.value.h),
        { fill, stroke, thin: true, corner: 4, opacity: 0.2 },
      );
      s(body);
      drag(body, center);
      body.el.style.cursor = "grab";
      s(
        label(
          Vec.derive(() => ({ x: Bx.value.x + 12, y: Bx.value.y + 14 })),
          labelText,
          { size: 13, bold: true, fill: stroke, align: Anchor.Left },
        ),
        handle(corner, { fill: "var(--text-color, #222)", r: 5, cursor: "nwse-resize" }),
      );
    };
    drawBox(A, "rgba(91,141,239,0.18)", "#5b8def", "A");
    drawBox(B, "rgba(232,131,58,0.18)", "#e8833a", "B");

    // ── Relation chips (click → write the relation) ────────────────
    const COLS = 4;
    const CW = 150;
    const CH = 30;
    const gridX0 = (W - COLS * CW) / 2 + CW / 2;
    const gridY0 = 232;
    RELATIONS.forEach((r, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cx = gridX0 + col * CW;
      const cy = gridY0 + row * (CH + 12);
      const active = derive(() => rel.value === r.code);
      const g = group(
        { translate: vec(cx - CW / 2 + 4, cy - CH / 2) },
        rect(0, 0, CW - 8, CH, {
          corner: 7,
          fill: derive(() => (active.value ? "#2f6df0" : "rgba(150,150,150,0.12)")),
          stroke: derive(() => (active.value ? "#2f6df0" : "#bbb")),
          thin: true,
        }),
        label(vec(14, CH / 2), r.code, {
          size: 12,
          bold: true,
          align: Anchor.Left,
          fill: derive(() => (active.value ? "#fff" : "#333")),
        }),
        label(vec(CW - 8 - 12, CH / 2), r.name, {
          size: 9,
          align: Anchor.Right,
          fill: derive(() => (active.value ? "rgba(255,255,255,0.85)" : "#888")),
        }),
      );
      g.el.style.cursor = "pointer";
      g.on("click", () => {
        rel.value = r.code;
      });
      s(g);
    });

    s(
      label(
        view.top.down(18),
        "(Box, Box) → RCC-8 — eight continuous DOF projected onto eight topological relations",
      ),
      label(
        Vec.derive(() => ({ x: view.center.value.x, y: 200 })),
        derive(() => `A is ${nameOf(rel.value)} B`),
        { size: 15, bold: true, align: Anchor.Center },
      ),
      label(
        view.bottom.up(12),
        "drag a box to move · drag its corner dot to resize · click a chip = reshape B into that relation",
        { size: 10 },
      ),
    );
  }
}
