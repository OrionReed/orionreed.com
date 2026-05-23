// avbd-primitives.test.ts — sketchpad-style geometric constraints
// implemented via the generic FD-based extensibility hook.

import { describe, expect, it } from "vitest";
import {
  angle,
  Cell,
  collinear,
  distance,
  equalDist,
  generic,
  midpoint,
  onCircle,
  parallel,
  perpendicular,
  Solver,
} from "../index";

describe("AVBD sketchpad primitives via FD", () => {
  it("angle ABC = 90° (right triangle)", () => {
    // Pin A and B, angle at B between A and C = π/2.
    const A = new Cell(2, [1, 0]);
    const B = new Cell(2, [0, 0]);
    const C = new Cell(2, [0, 1.5]);
    A.mass = 0;
    B.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    angle(s, A, B, C, Math.PI / 2);
    distance(s, B, C, 1);
    for (let i = 0; i < 20; i++) s.step();
    // C should land at distance 1 from B, at 90° to BA.
    const dBC = Math.hypot(C.position[0]!, C.position[1]!);
    expect(dBC).toBeCloseTo(1, 2);
    // Dot product of BA and BC should be 0.
    const dot = (A.position[0]! - 0) * C.position[0]! + (A.position[1]! - 0) * C.position[1]!;
    expect(Math.abs(dot)).toBeLessThan(0.05);
  });

  it("parallel: AB parallel to CD", () => {
    const A = new Cell(2, [0, 0]);
    const B = new Cell(2, [3, 0]);
    const C = new Cell(2, [0, 1]);
    const D = new Cell(2, [3, 2]);
    A.mass = 0;
    B.mass = 0;
    C.mass = 0; // pin three points; D is the only free one
    const s = new Solver({ iterations: 30 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    s.addCell(D);
    parallel(s, A, B, C, D);
    for (let i = 0; i < 20; i++) s.step();
    // AB is along x; CD must also be along x → D.y = C.y = 1.
    expect(D.position[1]!).toBeCloseTo(1, 2);
  });

  it("perpendicular: AB ⊥ CD", () => {
    const A = new Cell(2, [0, 0]);
    const B = new Cell(2, [1, 0]);
    const C = new Cell(2, [0, 0.5]);
    const D = new Cell(2, [2, 1]);
    A.mass = 0;
    B.mass = 0;
    C.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    s.addCell(D);
    perpendicular(s, A, B, C, D);
    for (let i = 0; i < 30; i++) s.step();
    // AB along x, CD must be along y → D.x = C.x = 0.
    expect(D.position[0]!).toBeCloseTo(0, 1);
  });

  it("collinear: P on line AB", () => {
    const A = new Cell(2, [0, 0]);
    const B = new Cell(2, [10, 5]);
    const P = new Cell(2, [3, 5]); // off the line
    A.mass = 0;
    B.mass = 0;
    const s = new Solver({ iterations: 50 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(P);
    collinear(s, P, A, B);
    for (let i = 0; i < 30; i++) s.step();
    // Cross product of AP and AB should be 0.
    const apx = P.position[0]! - 0;
    const apy = P.position[1]! - 0;
    const abx = 10,
      aby = 5;
    expect(Math.abs(apx * aby - apy * abx)).toBeLessThan(0.5);
  });

  it("onCircle: P on circle of given center+radius", () => {
    const center = new Cell(2, [0, 0]);
    const P = new Cell(2, [2, 0]); // off the circle
    center.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(center);
    s.addCell(P);
    onCircle(s, P, center, 1);
    for (let i = 0; i < 10; i++) s.step();
    expect(Math.hypot(P.position[0]!, P.position[1]!)).toBeCloseTo(1, 3);
  });

  it("equalDist: |AB| = |CD|", () => {
    const A = new Cell(2, [0, 0]);
    const B = new Cell(2, [3, 0]);
    const C = new Cell(2, [0, 0]);
    const D = new Cell(2, [5, 0]); // |CD|=5, |AB|=3
    A.mass = 0;
    B.mass = 0;
    C.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    s.addCell(D);
    equalDist(s, A, B, C, D);
    for (let i = 0; i < 20; i++) s.step();
    const dCD = Math.hypot(D.position[0]! - 0, D.position[1]! - 0);
    expect(dCD).toBeCloseTo(3, 2);
  });

  it("midpoint: M = (A+B)/2", () => {
    const A = new Cell(2, [0, 0]);
    const B = new Cell(2, [4, 6]);
    const M = new Cell(2, [0, 0]);
    A.mass = 0;
    B.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(M);
    midpoint(s, M, A, B);
    for (let i = 0; i < 5; i++) s.step();
    expect(M.position[0]!).toBeCloseTo(2, 3);
    expect(M.position[1]!).toBeCloseTo(3, 3);
  });

  it("custom user constraint: spring-of-springs (recursive structure)", () => {
    // A whimsical example: a "wave" constraint on three points where
    // the middle one is forced to track sin(time-equivalent).
    const A = new Cell(2, [0, 0]);
    const B = new Cell(2, [5, 0]);
    const C = new Cell(2, [10, 0]);
    A.mass = 0;
    C.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    // User-defined: B must satisfy B.x = average(A.x, C.x) AND
    //                          B.y = sin(B.x).
    generic(s, [A, B, C], 2, (pos, out) => {
      const a = pos[0]!,
        b = pos[1]!,
        c = pos[2]!;
      out[0]! = b[0]! - 0.5 * (a[0]! + c[0]!);
      out[1]! = b[1]! - Math.sin(b[0]!);
    });
    for (let i = 0; i < 20; i++) s.step();
    expect(B.position[0]!).toBeCloseTo(5, 2);
    expect(B.position[1]!).toBeCloseTo(Math.sin(5), 2);
  });
});
