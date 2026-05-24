// avbd-primitives.test.ts — sketchpad-style geometric constraints
// implemented via the generic FD-based extensibility hook.

import { describe, expect, it } from "vitest";
import { vec } from "../../signals";
import {
  angle,
  collinear,
  constraints,
  distance,
  equalDist,
  generic,
  midpoint,
  onCircle,
  parallel,
  perpendicular,
  pin,
} from "../index";

describe("AVBD sketchpad primitives via FD", () => {
  it("angle ABC = 90° (right triangle)", () => {
    const A = vec(1, 0);
    const B = vec(0, 0);
    const C = vec(0, 1.5);
    const s = constraints({ iterations: 30 });
    s.add(angle(A, B, C, Math.PI / 2));
    s.add(distance(B, C, 1));
    s.add(pin(A));
    s.add(pin(B));
    A.value = { x: 1.0001, y: 0 };
    expect(Math.hypot(C.value.x, C.value.y)).toBeCloseTo(1, 1);
    const dot = A.value.x * C.value.x + A.value.y * C.value.y;
    expect(Math.abs(dot)).toBeLessThan(0.1);
  });

  it("parallel: AB parallel to CD", () => {
    const A = vec(0, 0);
    const B = vec(3, 0);
    const C = vec(0, 1);
    const D = vec(3, 2);
    const s = constraints({ iterations: 30 });
    s.add(parallel(A, B, C, D));
    s.add(pin(A));
    s.add(pin(B));
    s.add(pin(C));
    A.value = { x: 0.0001, y: 0 };
    expect(D.value.y).toBeCloseTo(1, 1);
  });

  it("collinear: P on line AB", () => {
    const A = vec(0, 0);
    const B = vec(10, 5);
    const P = vec(3, 5);
    const s = constraints({ iterations: 50 });
    s.add(collinear(P, A, B));
    s.add(pin(A));
    s.add(pin(B));
    A.value = { x: 0.0001, y: 0 };
    const apx = P.value.x;
    const apy = P.value.y;
    expect(Math.abs(apx * 5 - apy * 10)).toBeLessThan(0.5);
  });

  it("onCircle: P on unit circle around origin", () => {
    const center = vec(0, 0);
    const P = vec(2, 0);
    const s = constraints({ iterations: 30 });
    s.add(onCircle(P, center, 1));
    s.add(pin(center));
    center.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(P.value.x, P.value.y)).toBeCloseTo(1, 1);
  });

  it("equalDist: |AB| = |CD|", () => {
    const A = vec(0, 0);
    const B = vec(3, 0);
    const C = vec(0, 0);
    const D = vec(5, 0);
    const s = constraints({ iterations: 30 });
    s.add(equalDist(A, B, C, D));
    s.add(pin(A));
    s.add(pin(B));
    s.add(pin(C));
    A.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(D.value.x, D.value.y)).toBeCloseTo(3, 1);
  });

  it("midpoint: M = (A+B)/2", () => {
    const A = vec(0, 0);
    const B = vec(4, 6);
    const M = vec(0, 0);
    const s = constraints({ iterations: 20 });
    s.add(midpoint(M, A, B));
    s.add(pin(A));
    s.add(pin(B));
    A.value = { x: 0.0001, y: 0 };
    expect(M.value.x).toBeCloseTo(2, 1);
    expect(M.value.y).toBeCloseTo(3, 1);
  });

  it("custom user constraint via generic", () => {
    const A = vec(0, 0);
    const B = vec(5, 0);
    const C = vec(10, 0);
    const s = constraints({ iterations: 20 });
    s.add(
      generic([A, B, C], 2, (pos, out) => {
        const a = pos[0]!,
          b = pos[1]!,
          c = pos[2]!;
        out[0]! = b[0]! - 0.5 * (a[0]! + c[0]!);
        out[1]! = b[1]! - Math.sin(b[0]!);
      }),
    );
    s.add(pin(A));
    s.add(pin(C));
    A.value = { x: 0.0001, y: 0 };
    expect(B.value.x).toBeCloseTo(5, 1);
    expect(B.value.y).toBeCloseTo(Math.sin(5), 1);
  });

  it("perpendicular: AB ⊥ CD", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0, 0.5);
    const D = vec(2, 1);
    const s = constraints({ iterations: 30 });
    s.add(perpendicular(A, B, C, D));
    s.add(pin(A));
    s.add(pin(B));
    s.add(pin(C));
    A.value = { x: 0.0001, y: 0 };
    expect(D.value.x).toBeCloseTo(0, 1);
  });
});
