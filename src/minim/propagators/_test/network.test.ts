// network.test.ts — `propagators()`, `propagate()`, manual mode, step().

import { describe, expect, it } from "vitest";
import { num, cell } from "../../signals";
import { add, allDifferent, propagate, propagators, type SetCell } from "..";

const eqSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};
const setCell = (init: Iterable<number>): SetCell<number> =>
  cell<ReadonlySet<number>>(new Set(init), { equals: eqSet });

describe("Propagators.add chainable", () => {
  it("returns this so add() can be chained / stored as expression", () => {
    const a = num(2);
    const b = num(3);
    const c = num(0);
    const p = propagators().add(add(a, b, c));
    expect(c.value).toBe(5);
    p.dispose();
  });
});

describe("propagate() free function", () => {
  it("equivalent to propagators().add(...)", () => {
    const a = num(1);
    const b = num(2);
    const c = num(0);
    const p = propagate(add(a, b, c));
    expect(c.value).toBe(3);
    a.value = 10;
    expect(c.value).toBe(12);
    p.dispose();
  });

  it("accepts heterogeneous propagator | propagator[] arguments", () => {
    const a = num(1);
    const b = num(2);
    const ab = num(0);
    const c = num(4);
    const total = num(0);
    // add() returns Propagator[]; propagate() spreads them.
    const p = propagate(add(a, b, ab), add(ab, c, total));
    expect(total.value).toBe(7);
    p.dispose();
  });
});

describe("manual mode + step()", () => {
  it("manual: true holds external mutations until step() drains them", () => {
    // Install first-fires propagators atomically (so derived cells
    // start populated). After that, manual mode pauses the fixpoint:
    // external mutations sit on the network until `step()` drains.
    const a = num(1);
    const b = num(2);
    const sum = num(0);

    const p = propagators({ manual: true });
    p.add(add(a, b, sum));

    expect(sum.value).toBe(3); // install fired the forward propagator

    a.value = 100;
    expect(sum.value).toBe(3); // held: no auto-drain

    p.step();
    expect(sum.value).toBe(102); // step drains the pending mutation
    p.dispose();
  });

  it("step() with no arg runs to convergence", () => {
    const a = num(1);
    const b = num(2);
    const c = num(4);
    const ab = num(0);
    const total = num(0);

    const p = propagators({ manual: true });
    p.add(add(a, b, ab), add(ab, c, total));

    a.value = 100;
    p.step(); // unbounded: should converge in one call.
    expect(ab.value).toBe(102);
    expect(total.value).toBe(106);
    p.dispose();
  });

  it("animated sudoku: step the fixpoint manually wave by wave", () => {
    // 4×4 mini-sudoku that solves entirely by naked-singles.
    const all = (): SetCell<number> => setCell([1, 2, 3, 4]);
    const grid: SetCell<number>[][] = [
      [all(), setCell([2]), all(), all()],
      [setCell([3]), all(), all(), setCell([4])],
      [all(), all(), setCell([1]), all()],
      [all(), all(), setCell([4]), all()],
    ];
    const constraints = [
      ...grid.map(row => allDifferent(...row)),
      ...[0, 1, 2, 3].map(c => allDifferent(...grid.map(row => row[c]!))),
      allDifferent(grid[0]![0]!, grid[0]![1]!, grid[1]![0]!, grid[1]![1]!),
      allDifferent(grid[0]![2]!, grid[0]![3]!, grid[1]![2]!, grid[1]![3]!),
      allDifferent(grid[2]![0]!, grid[2]![1]!, grid[3]![0]!, grid[3]![1]!),
      allDifferent(grid[2]![2]!, grid[2]![3]!, grid[3]![2]!, grid[3]![3]!),
    ];

    const p = propagators({ manual: true });
    p.add(...constraints);

    // Initial fire narrowed once. Step until stable (or cap).
    const isSolved = (): boolean => grid.flat().every(c => c.value.size === 1);
    let i = 0;
    while (!isSolved() && i++ < 50) p.step(1);

    expect(isSolved()).toBe(true);
    expect(i).toBeGreaterThan(0); // narrowing took multiple waves
    p.dispose();
  });
});
