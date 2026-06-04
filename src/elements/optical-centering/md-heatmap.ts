// md-heatmap.ts — `Array<Vec> → Grid<Count>`.
//
// The 2D sibling of `md-histogram`: scattered points projected onto a
// coarse grid of densities. Forward coarsens (keep counts, drop position);
// backward is 2D mass transport — click a cell to pull the nearest outside
// point in (+1), shift-click to push one out to a neighbour (−1).

import {
  Anchor,
  Diagram,
  derive,
  handle,
  label,
  type Mount,
  rect,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const W = 600;
const H = 400;
const COLS = 6;
const ROWS = 4;
const GR = { x: 60, y: 50, w: 480, h: 280 };
const CW = GR.w / COLS;
const CH = GR.h / ROWS;

type V = { x: number; y: number };

const colOf = (p: V) => Math.min(COLS - 1, Math.max(0, Math.floor((p.x - GR.x) / CW)));
const rowOf = (p: V) => Math.min(ROWS - 1, Math.max(0, Math.floor((p.y - GR.y) / CH)));
const cellOf = (p: V) => rowOf(p) * COLS + colOf(p);
const cellRect = (idx: number) => ({
  x: GR.x + (idx % COLS) * CW,
  y: GR.y + Math.floor(idx / COLS) * CH,
});

/** Distance from point `p` to cell `idx`'s rectangle (0 if inside). */
function distToCell(p: V, idx: number): number {
  const r = cellRect(idx);
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + CW));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + CH));
  return Math.hypot(dx, dy);
}

// 28 fixed points (deterministic spread).
const INIT: V[] = Array.from({ length: 28 }, (_, i) => {
  const a = (i * 2654435761) % 1000;
  const b = (i * 40503 + 137) % 1000;
  return { x: GR.x + 12 + (a / 1000) * (GR.w - 24), y: GR.y + 12 + (b / 1000) * (GR.h - 24) };
});

export class MdHeatmap extends Diagram {
  static styles = `text { pointer-events: none; }`;
  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const points: Writable<Vec>[] = INIT.map(p => vec(p.x, p.y));

    const counts = derive(() => {
      const c = new Array<number>(COLS * ROWS).fill(0);
      for (const pt of points) c[cellOf(pt.value)]!++;
      return c;
    });
    const maxCount = derive(() => Math.max(1, ...counts.value));

    /** +1: pull the nearest outside point into cell `idx`. */
    const pullIn = (idx: number) => {
      const vals = points.map(p => p.value);
      let best = -1;
      let bestD = Number.POSITIVE_INFINITY;
      for (let k = 0; k < vals.length; k++) {
        if (cellOf(vals[k]!) === idx) continue;
        const d = distToCell(vals[k]!, idx);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      if (best < 0) return;
      const r = cellRect(idx);
      const n = counts.value[idx]!;
      points[best]!.value = {
        x: r.x + CW * (0.3 + 0.12 * (n % 3)),
        y: r.y + CH * (0.3 + 0.12 * (Math.floor(n / 3) % 3)),
      };
    };

    /** −1: push a point from cell `idx` across its nearest edge. */
    const pushOut = (idx: number) => {
      const vals = points.map(p => p.value);
      const r = cellRect(idx);
      const inCell = vals
        .map((v, k) => ({ k, v }))
        .filter(o => cellOf(o.v) === idx)
        .sort((a, b) => edgeDist(a.v, r) - edgeDist(b.v, r));
      if (inCell.length === 0) return;
      const { k, v } = inCell[0]!;
      const dL = v.x - r.x;
      const dR = r.x + CW - v.x;
      const dT = v.y - r.y;
      const dB = r.y + CH - v.y;
      const m = Math.min(dL, dR, dT, dB);
      let nx = v.x;
      let ny = v.y;
      if (m === dL) nx = r.x - CW * 0.3;
      else if (m === dR) nx = r.x + CW * 1.3;
      else if (m === dT) ny = r.y - CH * 0.3;
      else ny = r.y + CH * 1.3;
      points[k]!.value = {
        x: Math.max(GR.x + 4, Math.min(GR.x + GR.w - 4, nx)),
        y: Math.max(GR.y + 4, Math.min(GR.y + GR.h - 4, ny)),
      };
    };

    // ── Cells ───────────────────────────────────────────────────────
    for (let idx = 0; idx < COLS * ROWS; idx++) {
      const r = cellRect(idx);
      const cellShape = rect(r.x, r.y, CW, CH, {
        fill: derive(
          () => `rgba(91,141,239,${0.06 + 0.62 * (counts.value[idx]! / maxCount.value)})`,
        ),
        stroke: "#cfd6e4",
        thin: true,
      });
      cellShape.el.style.cursor = "pointer";
      cellShape.on("click", e => {
        if ((e as MouseEvent).shiftKey || (e as MouseEvent).altKey) pushOut(idx);
        else pullIn(idx);
      });
      s(cellShape);
      s(
        label(
          vec(r.x + CW - 6, r.y + 12),
          derive(() => `${counts.value[idx]}`),
          { size: 10, align: Anchor.Right, fill: "#5b6b86", opacity: 0.8 },
        ),
      );
    }

    // ── Points (draggable → density follows) ────────────────────────
    points.forEach(pt => {
      const clamped = Vec.lens(
        [pt] as const,
        ([p]) => p,
        p => [
          {
            x: Math.max(GR.x + 2, Math.min(GR.x + GR.w - 2, p.x)),
            y: Math.max(GR.y + 2, Math.min(GR.y + GR.h - 2, p.y)),
          },
        ],
      );
      s(handle(clamped, { fill: "#1f3a63", r: 4 }));
    });

    s(
      label(view.top.down(18), "Array<Vec> → Grid<Count> — points projected onto a density grid"),
      label(
        view.bottom.up(12),
        "drag a point = re-bin (forward) · click a cell = pull nearest point in · shift-click = push one out (backward)",
        { size: 10 },
      ),
    );
  }
}

/** Distance from a point to the nearest edge of its containing cell. */
function edgeDist(v: V, r: { x: number; y: number }): number {
  return Math.min(v.x - r.x, r.x + CW - v.x, v.y - r.y, r.y + CH - v.y);
}
