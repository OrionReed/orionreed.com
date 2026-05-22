// Diagnostic: log iteration count per drag step to understand
// whether warm-start of `x` alone suffices for fast steady-state, or
// whether lambda persistence helps.

import { describe, expect, it } from "vitest";
import { dist, pinPoint, point } from "../constraints";
import { clusterHealth } from "../relate";
import { num } from "../index";

describe("diagnose: iters under continuous drag", () => {
  it("equilateral: log iters per tiny drag", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0.5), num(Math.sqrt(3) / 2));
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);
    pinPoint(B);

    const iters: number[] = [];
    let dx = 0;
    for (let i = 0; i < 20; i++) {
      dx += 0.01;
      A.x.value = dx;
      iters.push(clusterHealth(A.x)!.peek().iters);
    }
    console.log(`equilateral iters: ${JSON.stringify(iters)}`);
    expect(iters.length).toBe(20);
  });

  it("4-bar: log iters per tiny crank", () => {
    const O0 = point(num(0), num(0));
    const O3 = point(num(4), num(0));
    const A = point(num(1), num(0));
    const B = point(num(4), num(2));
    pinPoint(O0);
    pinPoint(O3);
    const b = Math.hypot(1 - 4, 0 - 2);
    dist(O0, A, 1);
    dist(O3, B, 2);
    dist(A, B, b);

    const iters: number[] = [];
    for (let i = 0; i < 20; i++) {
      const theta = i * 0.05;
      A.x.value = Math.cos(theta);
      A.y.value = Math.sin(theta);
      iters.push(clusterHealth(A.x)!.peek().iters);
    }
    console.log(`4-bar iters: ${JSON.stringify(iters)}`);
    expect(iters.length).toBe(20);
  });

  it("polygon: log iters per tiny rotation", () => {
    const O = point(num(0), num(0));
    const R = 1;
    const N = 8; // start smaller
    const verts = Array.from({ length: N }, (_, i) => {
      const a = (i * 2 * Math.PI) / N;
      return point(num(R * Math.cos(a)), num(R * Math.sin(a)));
    });
    for (let i = 0; i < N; i++) {
      const next = verts[(i + 1) % N]!;
      dist(verts[i]!, next, 2 * R * Math.sin(Math.PI / N));
    }
    pinPoint(O);
    pinPoint(verts[0]!);

    const iters: number[] = [];
    for (let i = 1; i < 20; i++) {
      const theta = i * 0.005;
      verts[0]!.x.value = Math.cos(theta);
      verts[0]!.y.value = Math.sin(theta);
      iters.push(clusterHealth(verts[0]!.x)!.peek().iters);
    }
    console.log(`8-gon iters: ${JSON.stringify(iters)}`);
    expect(iters.length).toBe(19);
  });
});
