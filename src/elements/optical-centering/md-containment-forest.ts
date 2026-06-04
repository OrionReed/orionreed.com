// md-containment-forest.ts — `Array<Box> → Forest`.
//
// A continuous domain (N rectangles, 4N DOF) projected onto a discrete
// combinatorial structure: the nesting forest "who contains whom." The
// codomain is a TREE, not a scalar — the bridge family grown past enums.
//
// Two coupled views of the same relation:
//   • LEFT (geometry): drag a box and its whole subtree travels with it.
//     Containment is recomputed every frame, so the forest reforms live —
//     this is the FORWARD pass (read = classify nesting from geometry).
//   • RIGHT (forest): drag a node onto another to reparent. The BACKWARD
//     pass realizes the requested nesting by affine-mapping the dragged
//     subtree to fit inside the target box. Drop on empty space = no-op;
//     to un-nest, drag the box out in the geometry view.

import {
  Anchor,
  type Box,
  box,
  cell,
  circle,
  Diagram,
  derive,
  drag,
  label,
  line,
  type Mount,
  rect,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const W = 720;
const H = 360;

// Spatial canvas (left) and tree canvas (right).
const SP = { x: 12, y: 44, w: 344, h: 292 };
const TR = { x: 380, y: 44, w: 328, h: 292 };

type BoxV = { x: number; y: number; w: number; h: number };

const NODES = [
  { label: "A", color: "#5b8def", init: { x: 40, y: 72, w: 290, h: 150 } },
  { label: "B", color: "#e8833a", init: { x: 60, y: 96, w: 120, h: 92 } },
  { label: "C", color: "#3aae6f", init: { x: 200, y: 100, w: 104, h: 84 } },
  { label: "D", color: "#b563d6", init: { x: 80, y: 122, w: 58, h: 42 } },
  { label: "E", color: "#d6a23a", init: { x: 40, y: 248, w: 118, h: 74 } },
  { label: "F", color: "#d65c6f", init: { x: 188, y: 248, w: 130, h: 74 } },
] as const;
const N = NODES.length;

const area = (b: BoxV) => b.w * b.h;

/** Strict geometric containment: `inner` fully within `outer` and smaller. */
function contains(outer: BoxV, inner: BoxV, tol = 1): boolean {
  return (
    area(inner) < area(outer) - 1 &&
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.w <= outer.x + outer.w + tol &&
    inner.y + inner.h <= outer.y + outer.h + tol
  );
}

/** Forward pass: parent[i] = smallest box that contains box i (-1 = root). */
function computeParents(vals: readonly BoxV[]): number[] {
  const parents = new Array<number>(vals.length).fill(-1);
  for (let i = 0; i < vals.length; i++) {
    let best = -1;
    let bestArea = Number.POSITIVE_INFINITY;
    for (let j = 0; j < vals.length; j++) {
      if (j === i) continue;
      if (contains(vals[j]!, vals[i]!) && area(vals[j]!) < bestArea) {
        best = j;
        bestArea = area(vals[j]!);
      }
    }
    parents[i] = best;
  }
  return parents;
}

/** Indices of i and everything nested under it (transitively). */
function subtreeOf(i: number, parents: readonly number[]): Set<number> {
  const out = new Set<number>([i]);
  let grew = true;
  while (grew) {
    grew = false;
    for (let k = 0; k < parents.length; k++) {
      if (!out.has(k) && parents[k]! >= 0 && out.has(parents[k]!)) {
        out.add(k);
        grew = true;
      }
    }
  }
  return out;
}

interface Layout {
  pos: { x: number; y: number }[];
  depth: number[];
}

/** Tidy forest layout: leaves get evenly-spaced x slots, internal nodes
 *  center over their children; y tracks depth. */
function layoutForest(parents: readonly number[]): Layout {
  const children: number[][] = Array.from({ length: N }, () => []);
  const roots: number[] = [];
  for (let i = 0; i < N; i++) {
    const p = parents[i]!;
    if (p < 0) roots.push(i);
    else children[p]!.push(i);
  }
  const slot = new Array<number>(N).fill(0);
  const depth = new Array<number>(N).fill(0);
  let leaf = 0;
  const dfs = (i: number, d: number) => {
    depth[i] = d;
    const kids = children[i]!;
    if (kids.length === 0) {
      slot[i] = leaf++;
      return;
    }
    for (const c of kids) dfs(c, d + 1);
    slot[i] = (slot[kids[0]!]! + slot[kids[kids.length - 1]!]!) / 2;
  };
  for (const r of roots) dfs(r, 0);
  const cols = Math.max(1, leaf);
  const levelH = 74;
  const topPad = 30;
  const pos = new Array(N).fill(null).map((_, i) => ({
    x: TR.x + ((slot[i]! + 0.5) / cols) * TR.w,
    y: TR.y + topPad + depth[i]! * levelH,
  }));
  return { pos, depth };
}

export class MdContainmentForest extends Diagram {
  static styles = `text { pointer-events: none; }`;
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const boxes: Writable<Box>[] = NODES.map(n => box(n.init.x, n.init.y, n.init.w, n.init.h));
    const parents = derive(() => computeParents(boxes.map(b => b.value)));
    const layout = derive(() => layoutForest(parents.value));

    // Reparent state for the tree view.
    const dragIdx = cell(-1);
    const ghost = cell<{ x: number; y: number }>({ x: 0, y: 0 });
    const nodeAt = (i: number): { x: number; y: number } => layout.value.pos[i]!;

    /** Nearest droppable node to `p`, excluding `i`'s own subtree. */
    const dropTargetFor = (i: number, p: { x: number; y: number }): number => {
      const sub = subtreeOf(i, parents.value);
      let best = -1;
      let bestD = 26 * 26;
      for (let j = 0; j < N; j++) {
        if (sub.has(j)) continue;
        const q = nodeAt(j);
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      return best;
    };
    const hovered = derive(() =>
      dragIdx.value < 0 ? -1 : dropTargetFor(dragIdx.value, ghost.value),
    );

    /** Backward pass: affine-map subtree of `i` to nest inside box `j`. */
    const reparent = (i: number, j: number) => {
      const vals = boxes.map(b => b.value);
      const sub = subtreeOf(i, computeParents(vals));
      const c = vals[i]!;
      const p = vals[j]!;
      const mm = 10;
      const availW = p.w - 2 * mm;
      const availH = p.h - 2 * mm;
      const k = Math.min(availW / c.w, availH / c.h, 1);
      const nx = p.x + (p.w - k * c.w) / 2;
      const ny = p.y + (p.h - k * c.h) / 2;
      for (const d of sub) {
        const b = vals[d]!;
        boxes[d]!.value = {
          x: nx + k * (b.x - c.x),
          y: ny + k * (b.y - c.y),
          w: k * b.w,
          h: k * b.h,
        };
      }
    };

    // ── Backdrops ──────────────────────────────────────────────────
    s(
      rect(SP.x, SP.y, SP.w, SP.h, {
        fill: "rgba(127,127,127,0.04)",
        stroke: "#ccc",
        thin: true,
        corner: 6,
      }),
      rect(TR.x, TR.y, TR.w, TR.h, {
        fill: "rgba(127,127,127,0.04)",
        stroke: "#ccc",
        thin: true,
        corner: 6,
      }),
    );

    // ── LEFT: nested boxes (drag moves the whole subtree) ───────────
    // Draw largest-first so children sit on top and grab first.
    const order = [...Array(N).keys()].sort((a, b) => area(NODES[b]!.init) - area(NODES[a]!.init));
    for (const i of order) {
      const Bi = boxes[i]!;
      const color = NODES[i]!.color;
      const center = Vec.lens(
        boxes,
        vs => ({ x: vs[i]!.x + vs[i]!.w / 2, y: vs[i]!.y + vs[i]!.h / 2 }),
        (target, vs) => {
          const ci = vs[i]!;
          const cw = ci.w / 2;
          const ch = ci.h / 2;
          const tx = Math.max(SP.x + cw, Math.min(SP.x + SP.w - cw, target.x));
          const ty = Math.max(SP.y + ch, Math.min(SP.y + SP.h - ch, target.y));
          const dx = tx - (ci.x + cw);
          const dy = ty - (ci.y + ch);
          const sub = subtreeOf(i, computeParents(vs));
          return vs.map((b, kk) =>
            sub.has(kk) ? { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h } : undefined,
          ) as never;
        },
      );
      const r = rect(
        derive(() => Bi.value.x),
        derive(() => Bi.value.y),
        derive(() => Bi.value.w),
        derive(() => Bi.value.h),
        { fill: color, opacity: 0.16, stroke: color, thin: true, corner: 4 },
      );
      s(r);
      drag(r, center);
      r.el.style.cursor = "grab";
      s(
        label(
          Vec.derive(() => ({ x: Bi.value.x + 6, y: Bi.value.y + 12 })),
          NODES[i]!.label,
          { size: 12, bold: true, fill: color, align: Anchor.Left },
        ),
      );
    }

    // ── RIGHT: forest as dots + lines ───────────────────────────────
    // Edges (one per node; hidden for roots). Endpoints follow ghost
    // while dragging, giving a rubber-band reparent preview.
    for (let i = 0; i < N; i++) {
      const from = Vec.derive(() => (dragIdx.value === i ? ghost.value : nodeAt(i)));
      const to = Vec.derive(() => {
        const par = parents.value[i]!;
        if (par < 0) return dragIdx.value === i ? ghost.value : nodeAt(i);
        return dragIdx.value === par ? ghost.value : nodeAt(par);
      });
      s(
        line(from, to, {
          stroke: "#aaa",
          thin: true,
          opacity: derive(() => (parents.value[i]! < 0 ? 0 : 0.6)),
        }),
      );
    }

    // Nodes.
    for (let i = 0; i < N; i++) {
      const color = NODES[i]!.color;
      const center = Vec.derive(() => (dragIdx.value === i ? ghost.value : nodeAt(i)));
      // Drop-target ring (non-interactive so it can't block grabbing a dot).
      const ring = circle(center, 14, {
        fill: "none",
        stroke: "#2f6df0",
        thin: true,
        opacity: derive(() => (hovered.value === i ? 0.9 : 0)),
      });
      ring.el.style.pointerEvents = "none";
      s(ring);
      const dot = circle(center, 9, {
        fill: color,
        stroke: "var(--bg-color, white)",
        strokeWidth: 2,
      });
      s(dot);
      s(
        label(center, NODES[i]!.label, {
          size: 9,
          bold: true,
          fill: "#fff",
          align: Anchor.Center,
        }),
      );
      // Custom pointer handling: ghost-follow + drop-to-reparent.
      let pid = -1;
      dot.el.style.cursor = "grab";
      dot.on("pointerdown", e => {
        const pe = e as PointerEvent;
        pid = pe.pointerId;
        dot.el.setPointerCapture(pid);
        dragIdx.value = i;
        ghost.value = dot.toWorld(pe);
      });
      dot.on("pointermove", e => {
        if (pid === -1) return;
        ghost.value = dot.toWorld(e as PointerEvent);
      });
      const stop = (e: Event) => {
        if (pid === -1) return;
        try {
          dot.el.releasePointerCapture(pid);
        } catch {
          /* ok */
        }
        pid = -1;
        const drop = dot.toWorld(e as PointerEvent);
        const j = dropTargetFor(i, drop);
        dragIdx.value = -1;
        if (j >= 0) reparent(i, j);
      };
      dot.on("pointerup", stop);
      dot.on("pointercancel", stop);
    }

    s(
      label(view.top.down(18), "Array<Box> → Forest — geometry projected onto a nesting tree"),
      label(vec(SP.x + SP.w / 2, SP.y - 6), "geometry — drag a box (subtree follows)", {
        size: 10,
        align: Anchor.Center,
      }),
      label(vec(TR.x + TR.w / 2, TR.y - 6), "forest — drag a node onto another to reparent", {
        size: 10,
        align: Anchor.Center,
      }),
      label(
        view.bottom.up(12),
        "read = smallest containing box · write (tree drag) = rescale the subtree to nest inside the target",
        { size: 10 },
      ),
    );
  }
}
