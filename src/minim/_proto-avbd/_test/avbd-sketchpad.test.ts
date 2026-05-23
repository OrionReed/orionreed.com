// avbd-sketchpad.test.ts — large mixed-constraint scenarios
// approximating real CAD / Sketchpad-style drawings.
//
// These probe whether AVBD scales for the realistic case: 100s-1000s
// of geometric primitives (points, lines, circles) bound by mixed
// constraints (distance, angle, parallel, perpendicular, on-line,
// on-circle). Different constraint types, different stiffness, and
// users dragging individual elements.

import { describe, expect, it } from "vitest";
import {
  distance,
  generic,
  onCircle,
  parallel,
  perpendicular,
  Solver,
  vec,
  VecCell,
} from "../index";

describe("AVBD sketchpad — mixed constraint types at scale", () => {
  it("100 points, 200 mixed constraints, drag one point", () => {
    const N = 10;
    const cells: VecCell[][] = [];
    for (let j = 0; j < N; j++) {
      const row: VecCell[] = [];
      for (let i = 0; i < N; i++) row.push(vec(i, j));
      cells.push(row);
    }
    cells[0]![0]!.mass = 0;
    const s = new Solver({ iterations: 8 });
    for (const row of cells) for (const c of row) s.addCell(c);
    for (let j = 0; j < N; j++) {
      for (let i = 1; i < N; i++) distance(s, cells[j]![i - 1]!, cells[j]![i]!, 1);
    }
    for (let i = 0; i < N; i++) {
      for (let j = 1; j < N; j++) distance(s, cells[j - 1]![i]!, cells[j]![i]!, 1);
    }
    for (let i = 0; i < N - 1; i++) {
      parallel(s, cells[0]![i]!, cells[0]![i + 1]!, cells[N - 1]![i]!, cells[N - 1]![i + 1]!);
    }
    cells[N - 1]![N - 1]!.mass = 0;
    cells[N - 1]![N - 1]!.value = { x: N - 1 + 0.5, y: N - 1 + 0.5 };
    for (let i = 0; i < 5; i++) s.step();
    const drags = 30;
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[N - 1]![N - 1]!.y = N - 1 + dy;
      s.step();
    }
    const t = (performance.now() - t0) / drags;
    console.log(`  100 cells + ~200 mixed constraints, drag: ${t.toFixed(3)}ms/step`);
    expect(Number.isFinite(t)).toBe(true);
  });

  it("1000 points, ~2500 mixed constraints (CAD-scale)", () => {
    const N = 32;
    const cells: VecCell[][] = [];
    for (let j = 0; j < N; j++) {
      const row: VecCell[] = [];
      for (let i = 0; i < N; i++) row.push(vec(i, j));
      cells.push(row);
    }
    cells[0]![0]!.mass = 0;
    const s = new Solver({ iterations: 5 });
    for (const row of cells) for (const c of row) s.addCell(c);

    for (let j = 0; j < N; j++)
      for (let i = 1; i < N; i++)
        distance(s, cells[j]![i - 1]!, cells[j]![i]!, 1);
    for (let i = 0; i < N; i++)
      for (let j = 1; j < N; j++)
        distance(s, cells[j - 1]![i]!, cells[j]![i]!, 1);

    for (let j = 1; j < N; j += 2) {
      parallel(
        s,
        cells[j]![0]!,
        cells[j]![1]!,
        cells[j - 1]![0]!,
        cells[j - 1]![1]!,
      );
    }
    for (let j = 0; j < N; j += 4) {
      perpendicular(
        s,
        cells[j]![0]!,
        cells[j]![1]!,
        cells[j]![0]!,
        cells[j + 1]?.[0] ?? cells[j]![0]!,
      );
    }
    const center = vec(N / 2, N / 2);
    center.mass = 0;
    s.addCell(center);
    for (let j = 0; j < N; j += 8) {
      for (let i = 0; i < N; i += 8) {
        onCircle(s, cells[j]![i]!, center, Math.hypot(j - N / 2, i - N / 2));
      }
    }
    const totalForces = s.forces.length;
    console.log(`  setup: ${cells.length * cells[0]!.length} cells, ${totalForces} mixed constraints`);

    cells[N - 1]![N - 1]!.mass = 0;
    cells[N - 1]![N - 1]!.value = { x: N - 1 + 0.5, y: N - 1 + 0.5 };
    for (let i = 0; i < 3; i++) s.step();
    const drags = 10;
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[N - 1]![N - 1]!.y = N - 1 + dy;
      s.step();
    }
    const t = (performance.now() - t0) / drags;
    console.log(
      `  1024 cells + ${totalForces} mixed constraints, drag: ${t.toFixed(2)}ms/step`,
    );
    expect(Number.isFinite(t)).toBe(true);
  });

  it("synthetic CAD: 200 points + bracket-like structure", () => {
    const N = 200;
    const cells: VecCell[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI;
      cells.push(vec(Math.cos(a), Math.sin(a)));
    }
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: 8 });
    for (const c of cells) s.addCell(c);

    const target = (2 * Math.PI) / N;
    for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, target);
    distance(s, cells[N - 1]!, cells[0]!, target);

    const center = vec(0, 0);
    center.mass = 0;
    s.addCell(center);
    for (let i = 0; i < N; i += 10) onCircle(s, cells[i]!, center, 1);

    cells[N / 2]!.mass = 0;
    cells[N / 2]!.x += 0.1;
    for (let i = 0; i < 3; i++) s.step();
    const drags = 20;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      cells[N / 2]!.x += 0.001;
      s.step();
    }
    const t = (performance.now() - t0) / drags;
    console.log(`  200-vertex polygon + circle constraints: ${t.toFixed(2)}ms/step`);
    let maxR = 0;
    for (let i = 0; i < N; i += 10) {
      const r = Math.hypot(cells[i]!.x, cells[i]!.y);
      if (Math.abs(r - 1) > maxR) maxR = Math.abs(r - 1);
    }
    expect(maxR).toBeLessThan(0.5);
  });
});

describe("AVBD sketchpad — does FD overhead matter?", () => {
  it("handcoded distance vs FD-based distance, same result", () => {
    const N = 16;

    const hcCells: VecCell[] = [];
    for (let i = 0; i < N; i++) hcCells.push(vec(i, 0));
    hcCells[0]!.mass = 0;
    const hcS = new Solver({ iterations: 30 });
    for (const c of hcCells) hcS.addCell(c);
    for (let i = 1; i < N; i++) distance(hcS, hcCells[i - 1]!, hcCells[i]!, 1);
    hcCells[N - 1]!.mass = 0;
    hcCells[N - 1]!.value = { x: N - 4, y: 2 };
    for (let i = 0; i < 10; i++) hcS.step();

    const fdCells: VecCell[] = [];
    for (let i = 0; i < N; i++) fdCells.push(vec(i, 0));
    fdCells[0]!.mass = 0;
    const fdS = new Solver({ iterations: 30 });
    for (const c of fdCells) fdS.addCell(c);
    for (let i = 1; i < N; i++) {
      const a = fdCells[i - 1]!,
        b = fdCells[i]!;
      generic(fdS, [a, b], 1, (pos, out) => {
        const p = pos[0]!,
          q = pos[1]!;
        out[0]! = Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!) - 1;
      });
    }
    fdCells[N - 1]!.mass = 0;
    fdCells[N - 1]!.value = { x: N - 4, y: 2 };
    for (let i = 0; i < 10; i++) fdS.step();

    for (let i = 1; i < N; i++) {
      const dHc = Math.hypot(
        hcCells[i]!.x - hcCells[i - 1]!.x,
        hcCells[i]!.y - hcCells[i - 1]!.y,
      );
      const dFd = Math.hypot(
        fdCells[i]!.x - fdCells[i - 1]!.x,
        fdCells[i]!.y - fdCells[i - 1]!.y,
      );
      expect(dHc).toBeCloseTo(1, 1);
      expect(dFd).toBeCloseTo(1, 1);
    }
  });
});
