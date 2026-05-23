// avbd-primitives.test.ts — sketchpad-style geometric constraints
// implemented via the generic FD-based extensibility hook.

import { describe, expect, it } from "vitest";
import {
  angle,
  collinear,
  distance,
  equalDist,
  generic,
  midpoint,
  onCircle,
  parallel,
  perpendicular,
  Solver,
  vec,
} from "../index";

describe("AVBD sketchpad primitives via FD", () => {
  it("angle ABC = 90° (right triangle)", () => {
    const A = vec(1, 0);
    const B = vec(0, 0);
    const C = vec(0, 1.5);
    A.mass = 0;
    B.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    angle(s, A, B, C, Math.PI / 2);
    distance(s, B, C, 1);
    for (let i = 0; i < 20; i++) s.step();
    const dBC = Math.hypot(C.x, C.y);
    expect(dBC).toBeCloseTo(1, 2);
    const dot = A.x * C.x + A.y * C.y;
    expect(Math.abs(dot)).toBeLessThan(0.05);
  });

  it("parallel: AB parallel to CD", () => {
    const A = vec(0, 0);
    const B = vec(3, 0);
    const C = vec(0, 1);
    const D = vec(3, 2);
    A.mass = 0;
    B.mass = 0;
    C.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    s.addCell(D);
    parallel(s, A, B, C, D);
    for (let i = 0; i < 20; i++) s.step();
    expect(D.y).toBeCloseTo(1, 2);
  });

  it("perpendicular: AB ⊥ CD", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0, 0.5);
    const D = vec(2, 1);
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
    expect(D.x).toBeCloseTo(0, 1);
  });

  it("collinear: P on line AB", () => {
    const A = vec(0, 0);
    const B = vec(10, 5);
    const P = vec(3, 5);
    A.mass = 0;
    B.mass = 0;
    const s = new Solver({ iterations: 50 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(P);
    collinear(s, P, A, B);
    for (let i = 0; i < 30; i++) s.step();
    const apx = P.x;
    const apy = P.y;
    const abx = 10,
      aby = 5;
    expect(Math.abs(apx * aby - apy * abx)).toBeLessThan(0.5);
  });

  it("onCircle: P on circle of given center+radius", () => {
    const center = vec(0, 0);
    const P = vec(2, 0);
    center.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(center);
    s.addCell(P);
    onCircle(s, P, center, 1);
    for (let i = 0; i < 10; i++) s.step();
    expect(Math.hypot(P.x, P.y)).toBeCloseTo(1, 3);
  });

  it("equalDist: |AB| = |CD|", () => {
    const A = vec(0, 0);
    const B = vec(3, 0);
    const C = vec(0, 0);
    const D = vec(5, 0);
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
    const dCD = Math.hypot(D.x, D.y);
    expect(dCD).toBeCloseTo(3, 2);
  });

  it("midpoint: M = (A+B)/2", () => {
    const A = vec(0, 0);
    const B = vec(4, 6);
    const M = vec(0, 0);
    A.mass = 0;
    B.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(M);
    midpoint(s, M, A, B);
    for (let i = 0; i < 5; i++) s.step();
    expect(M.x).toBeCloseTo(2, 3);
    expect(M.y).toBeCloseTo(3, 3);
  });

  it("custom user constraint: B = midpoint of AC and on a sine curve", () => {
    const A = vec(0, 0);
    const B = vec(5, 0);
    const C = vec(10, 0);
    A.mass = 0;
    C.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    generic(s, [A, B, C], 2, (pos, out) => {
      const a = pos[0]!,
        b = pos[1]!,
        c = pos[2]!;
      out[0]! = b[0]! - 0.5 * (a[0]! + c[0]!);
      out[1]! = b[1]! - Math.sin(b[0]!);
    });
    for (let i = 0; i < 20; i++) s.step();
    expect(B.x).toBeCloseTo(5, 2);
    expect(B.y).toBeCloseTo(Math.sin(5), 2);
  });
});
