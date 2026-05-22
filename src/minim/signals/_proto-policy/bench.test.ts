// bench.test.ts — perf comparisons for Num primitives + policy
// consolidation. Run via vitest; numbers print to console.

import { describe, it } from "vitest";
import { argminVec, num, polar, vec } from "../index";
import { argminVecViaPolicy, polarViaPolicy } from "./policy";

const N = 10_000;

function timed(label: string, fn: () => void): number {
  fn();
  fn(); // warmup
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(56)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / N).toFixed(2)}µs/op)`,
  );
  return ms;
}

describe("bench: Num primitives", () => {
  it("affine vs scale+add chain", () => {
    const a = num(0.5);
    const aff = a.affine(200, 30);
    timed("Num.affine read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i / N;
        s += aff.value;
      }
      if (s < -1e30) throw new Error("");
    });
    a.value = 0.5;
    timed("Num.affine write", () => {
      for (let i = 0; i < N; i++) aff.value = 30 + i * 0.02;
    });
  });

  it("affine vs equivalent .scale(200).add(30)", () => {
    const a = num(0.5);
    const chained = a.scale(200).add(30);
    timed(".scale(200).add(30) read (auto-fused via .through)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i / N;
        s += chained.value;
      }
      if (s < -1e30) throw new Error("");
    });
    a.value = 0.5;
    timed(".scale(200).add(30) write", () => {
      for (let i = 0; i < N; i++) chained.value = 30 + i * 0.02;
    });
  });

  it("clamp read + write", () => {
    const a = num(0.5);
    const c = a.clamp(0, 1);
    timed("Num.clamp read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = (i / N) * 2 - 0.5;
        s += c.value;
      }
      if (s < -1e30) throw new Error("");
    });
    a.value = 0.5;
    timed("Num.clamp write (within range)", () => {
      for (let i = 0; i < N; i++) c.value = (i / N) * 0.9 + 0.05;
    });
    timed("Num.clamp write (clipped)", () => {
      for (let i = 0; i < N; i++) c.value = (i / N) * 2 - 0.5;
    });
  });

  it("quantize + cyclic", () => {
    const a = num(0);
    const q = a.quantize(0.1);
    timed("Num.quantize write", () => {
      for (let i = 0; i < N; i++) q.value = i / N;
    });

    const ang = num(0);
    const cyc = ang.cyclic(2 * Math.PI);
    timed("Num.cyclic write", () => {
      for (let i = 0; i < N; i++) cyc.value = Math.cos(i * 0.01);
    });
  });
});

describe("bench: polar — stock vs policyLens-derived", () => {
  it("read", () => {
    const c = vec(100, 100),
      r = num(50),
      a = num(0.5);
    const p = polar(c, r, a);

    const c2 = vec(100, 100),
      r2 = num(50),
      a2 = num(0.5);
    const p2 = polarViaPolicy(c2.x, c2.y, r2, a2);

    timed("polar (stock) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a.value = i / N;
        s += p.value.x;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("polar (via policyLens) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        a2.value = i / N;
        s += p2.value.x;
      }
      if (s < -1e30) throw new Error("");
    });
  });

  it("write (circular policy)", () => {
    const c = vec(0, 0),
      r = num(50),
      a = num(0);
    const p = polar(c, r, a, "circular");

    const c2 = vec(0, 0),
      r2 = num(50),
      a2 = num(0);
    const p2 = polarViaPolicy(c2.x, c2.y, r2, a2, "circular");

    timed("polar (stock) write — circular", () => {
      for (let i = 0; i < N; i++) {
        p.value = { x: Math.cos(i / 100) * 50, y: Math.sin(i / 100) * 50 };
      }
    });
    timed("polar (via policyLens) write — circular", () => {
      for (let i = 0; i < N; i++) {
        p2.value = { x: Math.cos(i / 100) * 50, y: Math.sin(i / 100) * 50 };
      }
    });
  });
});

describe("bench: argminVec — stock vs policyLens-derived", () => {
  it("3-link IK write", () => {
    const fwd = (ts: readonly number[]) => {
      const L = 80;
      let x = 0,
        y = 0,
        s = 0;
      for (const t of ts) {
        s += t;
        x += L * Math.cos(s);
        y += L * Math.sin(s);
      }
      return { x, y };
    };

    const a1 = num(0.1),
      a2 = num(0.1),
      a3 = num(0.1);
    const tip = argminVec([a1, a2, a3], fwd, [1, 1, 1]);

    const b1 = num(0.1),
      b2 = num(0.1),
      b3 = num(0.1);
    const tip2 = argminVecViaPolicy([b1, b2, b3], fwd, [1, 1, 1]);

    const target = { x: 120, y: 80 };
    timed("argminVec (stock) write", () => {
      for (let i = 0; i < N; i++) tip.value = target;
    });
    // Reset
    a1.value = 0.1;
    a2.value = 0.1;
    a3.value = 0.1;
    b1.value = 0.1;
    b2.value = 0.1;
    b3.value = 0.1;
    timed("argminVec (via policyLens) write", () => {
      for (let i = 0; i < N; i++) tip2.value = target;
    });
  });
});
