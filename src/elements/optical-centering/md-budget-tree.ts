// md-budget-tree.ts — Tree<Num> with hierarchical sum aggregates.
//
// A nested budget rendered as a stacked-bar treemap. Three levels:
// root total, mid-level categories, leaf items. Each LEAF is its own
// `num()` cell; each internal node's value is `Num.lens([children],
// sum, redistribute)` — read as the sum of descendants, written by
// distributing the delta. The recursion bottoms out at leaves; every
// level above is the same lens primitive applied to its direct
// children's value cells.
//
// Each row in the diagram shows one tree depth: row 0 is "Total"
// (the root), row 1 shows the categories, row 2 shows the leaves.
// Within each row the widths are proportional to that level's value
// cells, so every row's total width is the same — visualising the
// invariant that `Σ leaves = Σ categories = total`.
//
// Drag any boundary between two adjacent rectangles to reapportion
// their values (conservation-of-total at that level). The change
// propagates up via the sum aggregate (parent's total updates) and
// stays consistent across rows.

import {
  Anchor,
  Diagram,
  derive,
  drag,
  label,
  type Mount,
  Num,
  num,
  rect,
  type TreeNode,
  treeNode,
  Vec,
  type Writable,
} from "../../minim";

// ─── Construction: sum-aggregate tree ────────────────────────────
//
// Each leaf is a plain writable `Num`. Each internal node is a
// `Num.lens([children], sum, redistribute)`: read = sum of children;
// write the parent's total = distribute the delta proportionally so
// siblings keep their relative shares.

interface Category {
  label: string;
  /** Aggregate cell — sum of this category's leaves; writes redistribute. */
  total: Writable<Num>;
  /** Direct children (leaves only in our 2-deep design). */
  leaves: { label: string; cell: Writable<Num> }[];
}

interface Budget {
  rootTotal: Writable<Num>;
  categories: Category[];
}

function makeBudget(): Budget {
  const data: Array<[string, Array<[string, number]>]> = [
    [
      "Housing",
      [
        ["Rent", 300],
        ["Utilities", 100],
      ],
    ],
    [
      "Food",
      [
        ["Groceries", 150],
        ["Dining", 150],
      ],
    ],
    [
      "Entertainment",
      [
        ["Subscriptions", 200],
        ["Events", 100],
      ],
    ],
  ];

  const categories: Category[] = data.map(([catLabel, leafSpecs]) => {
    const leaves = leafSpecs.map(([label, v]) => ({ label, cell: num(v) }));
    const total = Num.lens(
      leaves.map(l => l.cell),
      (vs: readonly number[]) => vs.reduce((a, b) => a + b, 0),
      (target, vs) => {
        const arr = vs as readonly number[];
        const cur = arr.reduce((a, b) => a + b, 0);
        if (cur === 0) {
          const even = target / arr.length;
          return arr.map(() => even) as never;
        }
        const scale = target / cur;
        return arr.map(v => v * scale) as never;
      },
    );
    return { label: catLabel, total, leaves };
  });

  // Root total = sum of category totals; writes redistribute.
  const rootTotal = Num.lens(
    categories.map(c => c.total),
    (vs: readonly number[]) => vs.reduce((a, b) => a + b, 0),
    (target, vs) => {
      const arr = vs as readonly number[];
      const cur = arr.reduce((a, b) => a + b, 0);
      if (cur === 0) {
        const even = target / arr.length;
        return arr.map(() => even) as never;
      }
      const scale = target / cur;
      return arr.map(v => v * scale) as never;
    },
  );

  return { rootTotal, categories };
}

// Build the Tree<Num> view of the budget (used for traversal helpers
// like leavesOf — but we hand-roll the rendering anyway, so this is
// mainly to make the structure explicit and assertable).
function asTree(budget: Budget): TreeNode<Writable<Num>> {
  return treeNode(
    budget.rootTotal,
    budget.categories.map(c =>
      treeNode(
        c.total,
        c.leaves.map(l => treeNode(l.cell)),
      ),
    ),
  );
}

// ─── Rendering ───────────────────────────────────────────────────

const W = 700;
const H = 280;
const PAD_X = 20;
const ROW_H = 56;
const ROW_GAP = 12;
const Y_ROOT = 60;
const Y_CAT = Y_ROOT + ROW_H + ROW_GAP;
const Y_LEAF = Y_CAT + ROW_H + ROW_GAP;
const BAR_X0 = PAD_X;
const BAR_W = W - 2 * PAD_X;

const CAT_FILLS = ["#5b8def", "#7ed321", "#e25c5c"];
const LEAF_FILLS = ["#a8c5f7", "#d0eea1", "#f3a4a4", "#bdd5f9", "#bce096", "#f2b8b8"];

export class MdBudgetTree extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const budget = makeBudget();
    const tree = asTree(budget);
    void tree;

    s(
      label(
        view.top.down(20),
        "drag any boundary — adjacent rectangles redistribute; parent totals update via sum",
      ),
    );

    // ─── Row 1: root total (one rect spanning the bar) ──────────
    this.renderRow(s, Y_ROOT, BAR_X0, BAR_W, [budget.rootTotal], ["TOTAL"], ["#222"], true);

    // ─── Row 2: categories ──────────────────────────────────────
    const catCells = budget.categories.map(c => c.total);
    const catLabels = budget.categories.map(c => c.label);
    this.renderRow(s, Y_CAT, BAR_X0, BAR_W, catCells, catLabels, CAT_FILLS, false);

    // ─── Row 3: leaves ──────────────────────────────────────────
    const leafCells: Writable<Num>[] = [];
    const leafLabels: string[] = [];
    let f = 0;
    const leafFills: string[] = [];
    for (const c of budget.categories) {
      for (const l of c.leaves) {
        leafCells.push(l.cell);
        leafLabels.push(l.label);
        leafFills.push(LEAF_FILLS[f % LEAF_FILLS.length]!);
        f++;
      }
    }
    this.renderRow(s, Y_LEAF, BAR_X0, BAR_W, leafCells, leafLabels, leafFills, false);

    s(
      label(
        view.bottom.up(14),
        "sum aggregate at each non-leaf: read = Σchildren; write = redistribute proportionally · invariant: every row's total width is equal",
        { size: 10 },
      ),
    );
  }

  /** Render one row of stacked rectangles whose widths are proportional
   *  to `cells`' values. Each interior boundary is a draggable handle
   *  that reapportions the two adjacent cells (preserving their sum). */
  private renderRow(
    s: Mount,
    y: number,
    x0: number,
    w: number,
    cells: readonly Writable<Num>[],
    labels: readonly string[],
    fills: readonly string[],
    isTotalRow: boolean,
  ): void {
    // Cumulative-width signal at each split point (left edge of each
    // rect). cumX[0] = x0, cumX[n] = x0 + w (always).
    const total = derive(() => cells.reduce((a, c) => a + c.value, 0));
    const widthOf = (i: number) =>
      derive(() => (cells[i]!.value / Math.max(total.value, 1e-9)) * w);
    const leftX = (i: number): Num => {
      // Lazy reactive accumulation.
      return Num.derive(() => {
        let acc = x0;
        for (let j = 0; j < i; j++) {
          acc += (cells[j]!.value / Math.max(total.value, 1e-9)) * w;
        }
        return acc;
      });
    };

    // Draw each rectangle.
    for (let i = 0; i < cells.length; i++) {
      const lx = leftX(i);
      const wd = widthOf(i);
      const opacity = isTotalRow ? 0.85 : 1;
      s(
        rect(lx, y, wd, ROW_H, {
          fill: fills[i]!,
          opacity,
          stroke: "#222",
          thin: true,
        }),
      );
      // Center-positioned labels inside each rect.
      const cyTop = y + 16;
      const cyMid = y + ROW_H - 14;
      const labelTop = Vec.derive(() => ({ x: lx.value + wd.value / 2, y: cyTop }));
      const labelMid = Vec.derive(() => ({ x: lx.value + wd.value / 2, y: cyMid }));
      s(
        label(labelTop, labels[i]!, {
          size: 11,
          bold: true,
          align: Anchor.Center,
          fill: isTotalRow ? "#fff" : "#111",
          opacity: derive(() => (wd.value > 50 ? 1 : 0)),
        }),
        label(
          labelMid,
          derive(() => `$${Math.round(cells[i]!.value)}`),
          {
            size: 11,
            align: Anchor.Center,
            fill: isTotalRow ? "#fff" : "#222",
            opacity: derive(() => (wd.value > 40 ? 0.95 : 0)),
          },
        ),
      );
    }

    // Draggable boundaries between adjacent rects. For each i in
    // [1, cells.length-1] we create a knob that pivots the
    // (cells[i-1], cells[i]) pair: read = the x of the boundary; write
    // = adjust both adjacent cells to put the boundary at that x.
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1]!;
      const b = cells[i]!;
      // The boundary's X position is leftX(i). Reading it is straight;
      // writing is "given a new boundary X, what (a, b) yields it?"
      // — keep the sum (a + b) constant; the new a-width = newBoundary -
      // leftX(i-1).
      const knob = Vec.lens(
        [a, b, leftX(i - 1)] as const,
        (vals: readonly [number, number, number]) => {
          const [va, vb, leftI1] = vals;
          const sumAB = va + vb;
          // Compute the boundary x given current cells.
          // boundary = leftI1 + (va / total_row) * w. We don't directly
          // know total_row here; but we know widthOf(i-1) = (va / total_row) * w.
          // For knob position, just return leftX(i).value:
          return { x: leftI1 + (va / sumAB) * (sumAB / total.peek()) * w, y: y + ROW_H / 2 };
        },
        (target, vals) => {
          const [va, vb, leftI1] = vals as readonly [number, number, number];
          const sumAB = va + vb;
          if (sumAB === 0) return [0, 0, undefined] as never;
          // Width allocated to (a + b) in pixels:
          const totalRow = total.peek();
          const widthAB = (sumAB / totalRow) * w;
          // New a in pixels = clamp(target.x - leftI1, 0, widthAB).
          const newAWPx = Math.max(0, Math.min(widthAB, target.x - leftI1));
          const newAValue = (newAWPx / widthAB) * sumAB;
          const newBValue = sumAB - newAValue;
          return [newAValue, newBValue, undefined] as never;
        },
      );
      // Vertical pill divider — visible, draggable directly. Thin
      // (6px) and spans 2/3 of the row height, centred vertically.
      const PILL_W = 6;
      const PILL_H = Math.round(ROW_H * (2 / 3));
      const PILL_Y = y + (ROW_H - PILL_H) / 2;
      const pillX = Num.derive(() => knob.value.x - PILL_W / 2);
      const pillShape = s(
        rect(pillX, PILL_Y, PILL_W, PILL_H, {
          fill: "black",
          stroke: "black",
          thin: true,
          corner: PILL_W / 2,
          opacity: 0.85,
        }),
      );
      drag(pillShape, knob);
      pillShape.el.style.cursor = "ew-resize";
    }
  }
}
