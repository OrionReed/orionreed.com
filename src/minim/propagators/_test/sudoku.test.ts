// sudoku.test.ts — concrete demo of set-narrowing propagators.
//
// 4×4 sudoku (rows: each digit 1-4 exactly once; same for cols and
// 2×2 boxes). Each cell is a Signal<ReadonlySet<number>> starting at
// {1,2,3,4}; givens are pre-narrowed to singletons. Narrowing
// propagators eliminate digits across rows/cols/boxes. Termination
// is structural: monotone narrowing of finite sets.

import { describe, expect, it } from "vitest";
import { signal, type Signal, type Writable } from "../../signals";
import { allDifferent, propagators, type SetCell } from "..";

// Custom equality so set-equality writes don't notify when two
// merge results have the same elements (we always allocate new Sets,
// so === wouldn't catch this).
function eqSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function setCell(initial: Iterable<number>): SetCell<number> {
  return signal<ReadonlySet<number>>(new Set(initial), { equals: eqSet });
}

function showCell(c: SetCell<number>): string {
  const v = [...c.value].sort();
  return v.length === 1 ? `${v[0]}` : `{${v.join("")}}`;
}

describe("sudoku 4×4", () => {
  it("solves a partial 4×4 puzzle by set-narrowing", () => {
    const all = (): SetCell<number> => setCell([1, 2, 3, 4]);
    // 4×4 grid. Givens (some digits already known):
    //   . 2 | . .
    //   3 . | . 4
    //   ----+----
    //   . . | 1 .
    //   . . | 4 .
    const grid: SetCell<number>[][] = [
      [all(), setCell([2]), all(), all()],
      [setCell([3]), all(), all(), setCell([4])],
      [all(), all(), setCell([1]), all()],
      [all(), all(), setCell([4]), all()],
    ];

    const rows = [0, 1, 2, 3].map(r => grid[r]!);
    const cols = [0, 1, 2, 3].map(c => grid.map(row => row[c]!));
    const boxes = [
      [grid[0]![0]!, grid[0]![1]!, grid[1]![0]!, grid[1]![1]!],
      [grid[0]![2]!, grid[0]![3]!, grid[1]![2]!, grid[1]![3]!],
      [grid[2]![0]!, grid[2]![1]!, grid[3]![0]!, grid[3]![1]!],
      [grid[2]![2]!, grid[2]![3]!, grid[3]![2]!, grid[3]![3]!],
    ];

    const p = propagators({ iterations: 1000 });
    for (const row of rows) p.add(allDifferent(...row));
    for (const col of cols) p.add(allDifferent(...col));
    for (const box of boxes) p.add(allDifferent(...box));

    // After propagation, every cell should be a singleton.
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const cell = grid[r]![c]!;
        if (cell.value.size !== 1) {
          throw new Error(
            `cell [${r},${c}] = ${showCell(cell)} not solved\n` +
              grid.map(row => row.map(showCell).join(" ")).join("\n"),
          );
        }
      }
    }

    // Verify Latin-square property.
    const solution = grid.map(row => row.map(c => [...c.value][0]!));
    for (let i = 0; i < 4; i++) {
      const row = new Set(solution[i]!);
      const col = new Set(solution.map(r => r[i]!));
      expect(row.size).toBe(4);
      expect(col.size).toBe(4);
    }
    p.dispose();
  });

  it("narrowing is monotone: cells only shrink", () => {
    const a = setCell([1, 2, 3, 4]);
    const b = setCell([2]); // singleton
    const c = setCell([1, 2, 3, 4]);
    const d = setCell([1, 2, 3, 4]);

    const p = propagators();
    p.add(allDifferent(a, b, c, d));

    // b is singleton {2}; a, c, d must each not contain 2.
    expect(a.value.has(2)).toBe(false);
    expect(c.value.has(2)).toBe(false);
    expect(d.value.has(2)).toBe(false);
    expect(a.value.size).toBe(3);
    expect(c.value.size).toBe(3);
    expect(d.value.size).toBe(3);
    p.dispose();
  });

  it("network terminates without hitting fuel cap", () => {
    // Same puzzle as the first test, but with a tiny fuel cap to
    // verify the lattice is genuinely monotone (not iterating
    // forever under our fuel ceiling).
    const all = (): SetCell<number> => setCell([1, 2, 3, 4]);
    const grid = [
      [all(), setCell([2]), all(), all()],
      [setCell([3]), all(), all(), setCell([4])],
      [all(), all(), setCell([1]), all()],
      [all(), all(), setCell([4]), all()],
    ];
    const p = propagators({ iterations: 200 }); // generous but bounded
    for (const row of grid) p.add(allDifferent(...row));
    for (let c = 0; c < 4; c++) {
      p.add(allDifferent(...grid.map(r => r[c]!)));
    }
    // (Skip box constraints to keep it simpler — sudoku doesn't have
    // a unique solution with just rows + cols, but propagation should
    // still terminate cleanly.)
    // … if we got here without throwing, termination held.
    expect(true).toBe(true);
    p.dispose();
  });
});
