// md-multitouch.ts — context-aware midpoint, driven by which points are held.
//
// A and B are draggable endpoints; M is their midpoint, expressed as a
// `Vec.lens`. M's bwd is a *context-aware* policy: it peeks each
// endpoint handle's `dragging` cell (set true between pointerdown and
// pointerup) and distributes the write accordingly. No pin cell is
// declared — the "is this point held" context already exists on the
// handles. Reads happen in the bwd, which runs untracked, so they add
// no graph edges and cannot form a cycle.
//
//   drag A / drag B      → that endpoint moves (M follows forward)
//   drag M, none held    → A + B translate rigidly (move the pair)
//   drag M, hold B       → A absorbs; B is pinned  (A + M move)
//   drag M, hold A       → B absorbs; A is pinned  (B + M move)
//   drag M, hold A and B → midpoint is locked      (write refused)

import {
  circle,
  Diagram,
  derive,
  handle,
  label,
  line,
  type Mount,
  num,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const A_COLOR = "#5b8def";
const B_COLOR = "#f5a623";
const M_COLOR = "#2ca58d";
const P_COLOR = "#a855f7";
// How far the slider hangs straight below its foot on the segment.
const DROP = 80;

export class MdMultitouch extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 380);
    const cy = view.center.value.y;

    const a: Writable<Vec> = vec(view.left.right(160).peek().x, cy - 50);
    const b: Writable<Vec> = vec(view.right.left(160).peek().x, cy + 10);

    // Segment behind everything else.
    s(line(a, b, { thin: true, opacity: 0.45 }));

    const hA = s(handle(a, { fill: A_COLOR, r: 12 }));
    const hB = s(handle(b, { fill: B_COLOR, r: 12 }));

    // Glow rings that fade in while an endpoint is held (pinned).
    s(ring(a, A_COLOR, hA.dragging), ring(b, B_COLOR, hB.dragging));

    // M = midpoint(A, B). The bwd consults the held state of A and B.
    const m = Vec.lens(
      [a, b] as const,
      ([av, bv]) => ({ x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 }),
      (target, [av, bv]) => {
        const aHeld = hA.dragging.peek();
        const bHeld = hB.dragging.peek();
        // Both pinned → midpoint can't move; refuse the write.
        if (aHeld && bHeld) return [undefined, undefined];
        // One pinned → the free endpoint absorbs the whole move so the
        // midpoint lands on `target`.
        if (bHeld) return [{ x: 2 * target.x - bv.x, y: 2 * target.y - bv.y }, undefined];
        if (aHeld) return [undefined, { x: 2 * target.x - av.x, y: 2 * target.y - av.y }];
        // Nothing pinned → translate both rigidly.
        const dx = target.x - (av.x + bv.x) / 2;
        const dy = target.y - (av.y + bv.y) / 2;
        return [
          { x: av.x + dx, y: av.y + dy },
          { x: bv.x + dx, y: bv.y + dy },
        ];
      },
    );

    s(handle(m, { fill: M_COLOR, r: 12 }));

    // P rides the segment at parameter t, hanging a fixed distance below.
    // Dragging it slides t (projecting the cursor back onto the line); A
    // and B are left alone, and P re-derives as they move.
    const t = num(0.32);
    const foot = Vec.derive(() => {
      const av = a.value;
      const bv = b.value;
      const tv = t.value;
      return { x: av.x + (bv.x - av.x) * tv, y: av.y + (bv.y - av.y) * tv };
    });
    const p = Vec.lens(
      [a, b, t] as const,
      ([av, bv, tv]) => ({
        x: av.x + (bv.x - av.x) * tv,
        y: av.y + (bv.y - av.y) * tv + DROP,
      }),
      (target, [av, bv]) => {
        // Lift the cursor back up to the line's height, project onto AB.
        const fx = target.x;
        const fy = target.y - DROP;
        const dx = bv.x - av.x;
        const dy = bv.y - av.y;
        const len2 = dx * dx + dy * dy || 1;
        const tt = ((fx - av.x) * dx + (fy - av.y) * dy) / len2;
        return [undefined, undefined, Math.max(0, Math.min(1, tt))];
      },
    );

    s(line(foot, p, { thin: true, dashed: true, opacity: 0.5 }));
    s(circle(foot, 4, { fill: P_COLOR }));
    s(handle(p, { fill: P_COLOR, r: 10 }));

    s(
      pointLabel(a, "A", A_COLOR),
      pointLabel(b, "B", B_COLOR),
      pointLabel(m, "M", M_COLOR),
      pointLabel(p, "P", P_COLOR, 28),
    );

    s(
      label(view.top.down(18), "drag A or B to move one · drag M to move both · slide P along"),
      label(
        view.bottom.up(16),
        "hold one point and drag M — the other absorbs · hold both to lock M",
        { size: 10 },
      ),
    );
  }
}

/** Soft highlight ring that fades in while `held` is true. */
function ring(at: Writable<Vec>, color: string, held: { value: boolean }) {
  return circle(at, 19, {
    thin: true,
    stroke: color,
    opacity: derive(() => (held.value ? 0.85 : 0)),
    aside: true,
  });
}

/** A single-letter label centered directly above (or below) a point. */
function pointLabel(at: Writable<Vec>, text: string, color: string, dy = -26) {
  return label(
    Vec.derive(at, q => ({ x: q.x, y: q.y + dy })),
    text,
    { size: 14, fill: color },
  );
}
