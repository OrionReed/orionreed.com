// md-prop-sudoku.ts — animated set-narrowing sudoku solver.
//
// 9×9 sudoku, easy puzzle. Each cell is a `Set<1..9>` signal;
// constraints are 27 `allDifferent` propagators (rows, cols, boxes).
// The network is in MANUAL MODE so the fixpoint advances one wave
// per ~0.35s, letting you watch the candidates narrow until every
// cell collapses to a singleton.
//
// Layout is itself propagator-driven: `grid(view, cellBoxes, …)`
// places 81 boxes; each cell's rect / digit / candidates read its
// reactive `b.x, b.y, b.at(u, v)` field views. No manual coordinate
// math anywhere.

import {
  allDifferent,
  box,
  grid,
  inset,
  propagate,
  propagators,
  type SetCell,
} from "@minim/propagators";
import { Diagram, derive, label, line, loop, type Mount, rect, cell } from "../../minim";

const BASE_PUZZLE =
  "53..7...." +
  "6..195..." +
  ".98....6." +
  "8...6...3" +
  "4..8.3..1" +
  "7...2...6" +
  ".6....28." +
  "...419..5" +
  "....8..79";

const ALL_9: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const eqSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};
const setCell = (init: Iterable<number>): SetCell<number> =>
  cell<ReadonlySet<number>>(new Set(init), { equals: eqSet });

const GIVEN = "var(--text)";
const SOLVED = "#5b8def";
const CANDIDATE = "var(--text-muted, #888)";

export class MdPropSudoku extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 480);

    // ─── Cells + constraints ────────────────────────────────────────
    const cells: SetCell<number>[][] = Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, () => setCell(ALL_9)),
    );
    const givenAt = cell(new Set<number>());

    const p = propagators({ manual: true });
    for (let r = 0; r < 9; r++) p.add(allDifferent(...cells[r]!));
    for (let c = 0; c < 9; c++) p.add(allDifferent(...cells.map(row => row[c]!)));
    for (let br = 0; br < 3; br++) {
      for (let bc = 0; bc < 3; bc++) {
        const cellsInBox = [];
        for (let dr = 0; dr < 3; dr++) {
          for (let dc = 0; dc < 3; dc++) {
            cellsInBox.push(cells[br * 3 + dr]![bc * 3 + dc]!);
          }
        }
        p.add(allDifferent(...cellsInBox));
      }
    }

    // ─── Layout: grid(view-padded, 81 cell boxes) ───────────────────
    const gridArea = box();
    const cellBoxes = Array.from({ length: 81 }, () => box());
    propagate(inset(view, gridArea, { padding: 30 }), grid(gridArea, cellBoxes, { cols: 9 }));

    // ─── Render ─────────────────────────────────────────────────────
    for (let i = 0; i < 81; i++) {
      const b = cellBoxes[i]!;
      const cell = cells[Math.floor(i / 9)]![i % 9]!;
      const isGiven = (): boolean => givenAt.value.has(i);

      s(
        rect(b.x, b.y, b.w, b.h, {
          stroke: "#aaa",
          thin: true,
          fill: derive(() => (isGiven() ? "#00000008" : "transparent")),
        }),
        // Big digit when narrowed to a singleton.
        label(
          b.center,
          derive(() => (cell.value.size === 1 ? `${[...cell.value][0]}` : "")),
          {
            size: 22,
            fill: derive(() => (isGiven() ? GIVEN : SOLVED)),
          },
        ),
      );
      // 3×3 candidates inside the cell, positions via `b.at(u, v)`.
      for (let gy = 0; gy < 3; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          const digit = gy * 3 + gx + 1;
          s(
            label(
              b.at((gx + 0.5) / 3, (gy + 0.5) / 3),
              derive(() => (cell.value.size > 1 && cell.value.has(digit) ? `${digit}` : "")),
              { size: 9, fill: CANDIDATE },
            ),
          );
        }
      }
    }

    // 3×3 box dividers as thicker overlay lines at u ∈ {0, 1/3, 2/3, 1}.
    for (const u of [0, 1 / 3, 2 / 3, 1]) {
      s(
        line(gridArea.at(u, 0), gridArea.at(u, 1), { stroke: "#666", strokeWidth: 2 }),
        line(gridArea.at(0, u), gridArea.at(1, u), { stroke: "#666", strokeWidth: 2 }),
      );
    }

    const stepCount = cell(0);
    const solved = cell(false);

    s(
      label(
        view.top.down(20),
        derive(() =>
          solved.value
            ? "solved · ✓ all cells singletons"
            : `narrowing · wave ${stepCount.value} · candidates shrinking via allDifferent`,
        ),
      ),
      label(
        view.bottom.up(14),
        "27 allDifferent propagators · 9 rows + 9 cols + 9 boxes · one fixpoint wave / 0.35s",
        { size: 10 },
      ),
    );

    // ─── Animation: reset → step until stable → hold → repeat ──────
    const totalCands = (): number => cells.flat().reduce((acc, c) => acc + c.value.size, 0);

    this.anim.start(
      loop(function* () {
        const puzzle = shufflePuzzle(BASE_PUZZLE);
        const newGivens = new Set<number>();
        for (let i = 0; i < 81; i++) {
          const ch = puzzle[i]!;
          cells[Math.floor(i / 9)]![i % 9]!.value =
            ch === "." ? new Set(ALL_9) : new Set([Number.parseInt(ch, 10)]);
          if (ch !== ".") newGivens.add(i);
        }
        givenAt.value = newGivens;
        stepCount.value = 0;
        solved.value = false;

        let prev = totalCands();
        while (prev > 81) {
          yield 0.35;
          p.step(1);
          stepCount.value++;
          const cur = totalCands();
          if (cur === prev) break; // stalled (puzzle needs more than naked singles)
          prev = cur;
        }
        solved.value = totalCands() === 81;
        yield 1.5;
      }),
    );
  }
}

// ─── Puzzle shuffling ────────────────────────────────────────────────

/** Random row-within-band, column-within-stack, and digit
 *  permutations preserve constraint satisfaction, so a puzzle
 *  solvable by naked-singles stays solvable. ~10¹⁰ visual variants
 *  from one base puzzle. */
function shufflePuzzle(base: string): string {
  const grid: string[][] = [];
  for (let r = 0; r < 9; r++) grid.push(base.slice(r * 9, r * 9 + 9).split(""));

  for (let g = 0; g < 3; g++) {
    const rows = shuffled([0, 1, 2]).map(i => g * 3 + i);
    const newRows = rows.map(i => grid[i]!);
    for (let i = 0; i < 3; i++) grid[g * 3 + i] = newRows[i]!;

    const cols = shuffled([0, 1, 2]).map(i => g * 3 + i);
    for (let r = 0; r < 9; r++) {
      const newCols = cols.map(i => grid[r]![i]!);
      for (let i = 0; i < 3; i++) grid[r]![g * 3 + i] = newCols[i]!;
    }
  }

  const perm = shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  return grid
    .flat()
    .map(ch => (ch === "." ? "." : `${perm[Number.parseInt(ch, 10) - 1]}`))
    .join("");
}

function shuffled<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i]!, a[j]!] = [a[j]!, a[i]!];
  }
  return a;
}
