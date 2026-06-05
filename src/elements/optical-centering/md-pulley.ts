// md-pulley.ts — rope-length conservation, composed across two pulleys.
//
// A single pulley conserving rope length is `b = a.affine(−1, L)`. Chain
// a second pulley and the law composes: a third weight reads
// `c = b.affine(−1, L₂)`. Every edge is invertible, so dragging any of the
// three weights ripples through the others — the middle weight opposes the
// outer two, which track together. The pulleys themselves slide along the
// girder, and the shared middle rope stays tangent to each wheel.

import {
  circle,
  Diagram,
  drag,
  label,
  line,
  type Mount,
  num,
  rect,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const W = 560;
const H = 380;
const PY = 110; // pulley axle height
const GY = PY - 32; // girder height
const R = 26; // pulley radius
const L1 = 250;
const L2 = 250;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Tangent point from external point E to circle (C, R) — the upper one,
 *  so the rope reads as wrapping over the top of the wheel. */
function tangent(
  e: { x: number; y: number },
  c: { x: number; y: number },
): { x: number; y: number } {
  const dx = e.x - c.x;
  const dy = e.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  const phi = Math.atan2(dy, dx);
  const beta = Math.acos(clamp(R / d, -1, 1));
  const p = (a: number) => ({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
  const a = p(phi + beta);
  const b = p(phi - beta);
  return a.y < b.y ? a : b;
}

export class MdPulley extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const p1 = vec(180, PY);
    const p2 = vec(380, PY);
    // Pulleys slide horizontally on the girder (y pinned, kept apart).
    const p1h = Vec.lens(
      [p1, p2] as const,
      ([a]) => a,
      (t, [, b]) => [{ x: clamp(t.x, 40 + R + 10, b.x - 120), y: PY }, undefined] as never,
    );
    const p2h = Vec.lens(
      [p2, p1] as const,
      ([a]) => a,
      (t, [, b]) => [{ x: clamp(t.x, b.x + 120, W - 40 - R - 10), y: PY }, undefined] as never,
    );

    // Conservation chain: each pulley is one invertible affine edge.
    const aDrop = num(130);
    const bDrop = aDrop.affine(-1, L1);
    const cDrop = bDrop.affine(-1, L2);

    // Weights: vertical-only drag writes the drop; x rides the pulleys.
    // Each drop is clamped so no weight rises above the girder — the affine
    // links carry the bound to the others (a up ⇒ b down ⇒ c up, etc.).
    const M = 44; // min drop below the axle
    const aPos = Vec.lens(
      [aDrop, p1] as const,
      ([d, P1]) => ({ x: P1.x - R, y: PY + d }),
      t => [clamp(t.y - PY, M, L1 - M), undefined] as never,
    );
    const cPos = Vec.lens(
      [cDrop, p2] as const,
      ([d, P2]) => ({ x: P2.x + R, y: PY + d }),
      t => [clamp(t.y - PY, M, L2 - M), undefined] as never,
    );
    const bPos = Vec.lens(
      [bDrop, p1, p2] as const,
      ([d, P1, P2]) => ({ x: (P1.x + P2.x) / 2, y: PY + d }),
      t => [clamp(t.y - PY, M, L1 - M), undefined, undefined] as never,
    );

    // Girder + pulley mounts.
    s(line(vec(40, GY), vec(W - 40, GY), { strokeWidth: 3 }));
    s(
      line(
        Vec.derive(() => ({ x: p1.x.value, y: GY })),
        p1,
        { thin: true },
      ),
    );
    s(
      line(
        Vec.derive(() => ({ x: p2.x.value, y: GY })),
        p2,
        { thin: true },
      ),
    );

    // Ropes: A and C straight down; B held by a rope tangent to each wheel.
    s(
      line(
        Vec.derive(() => ({ x: p1.x.value - R, y: PY })),
        aPos,
        { thin: true },
      ),
    );
    s(
      line(
        Vec.derive(() => ({ x: p2.x.value + R, y: PY })),
        cPos,
        { thin: true },
      ),
    );
    s(
      line(
        bPos,
        Vec.derive(() => tangent(bPos.value, p1.value)),
        { thin: true },
      ),
    );
    s(
      line(
        bPos,
        Vec.derive(() => tangent(bPos.value, p2.value)),
        { thin: true },
      ),
    );

    // Pulleys (draggable horizontally).
    for (const [p, h] of [
      [p1, p1h],
      [p2, p2h],
    ] as const) {
      const wheel = s(circle(p, R, { thin: true }));
      drag(wheel, h);
      wheel.el.style.cursor = "ew-resize";
      wheel.el.style.pointerEvents = "all"; // grab the whole disc, not just the rim
      const hub = s(circle(p, 2.5, { fill: true }));
      hub.el.style.pointerEvents = "none";
    }

    const weight = (pos: Writable<Vec>, fill: string, name: string) => {
      const r = s(rect(pos, 40, 28, { fill, corner: 3 }));
      drag(r, pos);
      r.el.style.cursor = "ns-resize";
      s(label(pos, name, { size: 12, fill: "#fff", bold: true }));
    };
    weight(aPos, "#5b8def", "A");
    weight(bPos, "#e2a33c", "B");
    weight(cPos, "#e25c5c", "C");

    s(
      label(view.top.down(20), "drag a weight — or slide a pulley along the girder"),
      label(
        view.bottom.up(16),
        "b = a.affine(−1, L₁) · c = b.affine(−1, L₂) · two invertible edges composed",
        { size: 10 },
      ),
    );
  }
}
