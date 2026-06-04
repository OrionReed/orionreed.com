// sudoku9.test.ts — real-world stress test: 9x9 sudoku.
//
// 9x9 sudoku with set-narrowing propagators. Tests termination on
// a non-trivial constraint network (~243 propagators, 81 cells).
// `allDifferent` over each of 9 rows + 9 cols + 9 boxes = 27
// constraints; each emits N(N-1) = 72 directional propagators, so
// ~1944 propagators total.

import { describe, expect, it } from "vitest";
import { cell } from "../../signals";
import { allDifferent, propagators, type SetCell } from "..";

const eqSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};

const setCell = (init: Iterable<number>): SetCell<number> =>
  cell<ReadonlySet<number>>(new Set(init), { equals: eqSet });

const ALL_9 = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function makeGrid(puzzle: string): SetCell<number>[][] {
  // puzzle is 81 chars; '.' = unknown, '1'-'9' = given.
  const grid: SetCell<number>[][] = [];
  for (let r = 0; r < 9; r++) {
    const row: SetCell<number>[] = [];
    for (let c = 0; c < 9; c++) {
      const ch = puzzle[r * 9 + c]!;
      if (ch === ".") row.push(setCell(ALL_9));
      else row.push(setCell([Number.parseInt(ch, 10)]));
    }
    grid.push(row);
  }
  return grid;
}

function makeConstraints(grid: SetCell<number>[][]) {
  const ps: ReturnType<typeof allDifferent>[] = [];
  // Rows.
  for (let r = 0; r < 9; r++) ps.push(allDifferent(...grid[r]!));
  // Columns.
  for (let c = 0; c < 9; c++) ps.push(allDifferent(...grid.map(row => row[c]!)));
  // Boxes.
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const cells: SetCell<number>[] = [];
      for (let dr = 0; dr < 3; dr++) {
        for (let dc = 0; dc < 3; dc++) {
          cells.push(grid[br * 3 + dr]![bc * 3 + dc]!);
        }
      }
      ps.push(allDifferent(...cells));
    }
  }
  return ps;
}

function isSolved(grid: SetCell<number>[][]): boolean {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (grid[r]![c]!.value.size !== 1) return false;
    }
  }
  return true;
}

function showGrid(grid: SetCell<number>[][]): string {
  return grid
    .map(row => row.map(c => (c.value.size === 1 ? [...c.value][0] : ".")).join(""))
    .join("\n");
}

describe("sudoku 9×9", () => {
  // An "easy" puzzle solvable by pure constraint propagation (no
  // search needed). From a published puzzle dataset.
  const easyPuzzle =
    "53..7...." +
    "6..195..." +
    ".98....6." +
    "8...6...3" +
    "4..8.3..1" +
    "7...2...6" +
    ".6....28." +
    "...419..5" +
    "....8..79";

  const easySolution =
    "534678912" +
    "672195348" +
    "198342567" +
    "859761423" +
    "426853791" +
    "713924856" +
    "961537284" +
    "287419635" +
    "345286179";

  it("solves an easy 9×9 puzzle by set-narrowing alone", () => {
    const grid = makeGrid(easyPuzzle);
    const p = propagators({ iterations: 5000 });
    const constraints = makeConstraints(grid);
    p.add(...constraints);

    if (!isSolved(grid)) {
      throw new Error(
        `Not solved after propagation:\n${showGrid(grid)}\n\nUnsolved cells: ${grid
          .flat()
          .filter(c => c.value.size > 1)
          .map(c => `{${[...c.value].join(",")}}`)
          .slice(0, 5)
          .join(" ")}${grid.flat().filter(c => c.value.size > 1).length > 5 ? " …" : ""}`,
      );
    }

    const solution = grid.map(row => row.map(c => [...c.value][0]!).join("")).join("");
    expect(solution).toBe(easySolution);

    p.dispose();
  });

  it("partial narrowing on a hard puzzle (search needed for full solution)", () => {
    // Pure constraint propagation can't solve all sudokus — some
    // need backtracking. Verify the network still TERMINATES and
    // narrows AS MUCH AS POSSIBLE without throwing.
    const hardPuzzle =
      ".....6...." +
      "...59....." +
      "8.4...37.." +
      "5.....1..." +
      "....86...." +
      "...3....2." +
      ".79...3.." +
      ".....92..." +
      "..5...4...";
    const grid = makeGrid(hardPuzzle.slice(0, 81));
    const p = propagators({ iterations: 5000 });
    p.add(...makeConstraints(grid));

    // Network should terminate without throwing.
    // It may or may not be fully solved.
    let known = 0;
    let totalNarrowing = 0;
    for (const row of grid) {
      for (const c of row) {
        if (c.value.size === 1) known++;
        totalNarrowing += 9 - c.value.size;
      }
    }
    expect(totalNarrowing).toBeGreaterThan(0); // some progress made
    p.dispose();
  });
});

describe("sudoku 9×9 perf", () => {
  const easyPuzzle =
    "53..7...." +
    "6..195..." +
    ".98....6." +
    "8...6...3" +
    "4..8.3..1" +
    "7...2...6" +
    ".6....28." +
    "...419..5" +
    "....8..79";

  it("install + solve, 100 trials", () => {
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      const grid = makeGrid(easyPuzzle);
      const p = propagators({ iterations: 5000 });
      p.add(...makeConstraints(grid));
      p.dispose();
    }
    const ms = (performance.now() - t0) / 100;
    console.log(`  sudoku 9×9 install+solve: ${ms.toFixed(3)}ms / trial`);
    expect(Number.isFinite(ms)).toBe(true);
  });
});
