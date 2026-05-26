// lazy-realworld.bench.test.ts — steady-state cost of field-lens
// access on Vec / Box / memoised derived views, after the `lazy()`
// redesign (own-property shadows the prototype getter; subsequent
// reads skip the getter entirely).

import { describe, it } from "vitest";
import { box, vec } from "../index";

const N = 100_000;

function timed(label: string, fn: () => void): number {
  fn();
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(60)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / N).toFixed(3)}µs/op)`,
  );
  return ms;
}

describe("bench: field-lens access on Vec / Box (lazy steady state)", () => {
  it("Vec — repeated `.x` reads", () => {
    const v = vec(3, 4);
    v.x;
    timed("v.x.value", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += v.x.value;
      if (s < -1) throw new Error("");
    });
  });

  it("Vec — alternating `.x` / `.y`", () => {
    const v = vec(3, 4);
    v.x;
    v.y;
    timed("v.x.value + v.y.value", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += v.x.value + v.y.value;
      if (s < -1) throw new Error("");
    });
  });

  it("Box — `.x`, `.y`, `.w`, `.h`", () => {
    const b = box(0, 0, 100, 50);
    b.x;
    b.y;
    b.w;
    b.h;
    timed("b.x + b.y + b.w + b.h", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += b.x.value + b.y.value + b.w.value + b.h.value;
      if (s < -1) throw new Error("");
    });
  });

  it("Vec.magnitude — memoised derived view", () => {
    const v = vec(3, 4);
    v.magnitude;
    timed("v.magnitude.value", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += v.magnitude.value;
      if (s < -1) throw new Error("");
    });
  });

  it("Box.center — memoised anchor (Vec)", () => {
    const b = box(0, 0, 100, 50);
    b.center;
    timed("b.center.value.x", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += b.center.value.x;
      if (s < -1) throw new Error("");
    });
  });

  it("First-call cost — N fresh Vecs, single .x read", () => {
    // Cold path: each instance pays the defineProperty install once.
    const vs = new Array(N);
    for (let i = 0; i < N; i++) vs[i] = vec(i, i);
    timed("first .x on N fresh Vecs", () => {
      let s = 0;
      for (let i = 0; i < N; i++) s += vs[i].x.value;
      if (s < -1) throw new Error("");
    });
  });
});
