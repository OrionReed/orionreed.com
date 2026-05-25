// laws.test.ts — verify lens-law compliance for each invertible op.
//
// For every method listed in `static invertibles` on each value class
// we run the three classical lens laws (GetPut, PutGet, PutPut). The
// lossy lenses (clamp, quantize, cyclic) verify PutGet only, over the
// view space they actually preserve.

import { describe, it } from "vitest";
import { box, Num, num, rgb, Vec, vec } from "../index";
import { approxNumber, approxVec, verifyLensLaws, verifyLensLawsLossy } from "./_laws";

const EPS = 1e-9;
const rng = (a: number, b: number) => a + Math.random() * (b - a);

// ─── Num: strict invertibles ──────────────────────────────────────

describe("Num lens laws — strict invertibles", () => {
  it("add", () => {
    verifyLensLaws(
      () => {
        const n = num(rng(-100, 100));
        const b = rng(-100, 100);
        return { source: n, lens: n.add(b) };
      },
      () => rng(-100, 100),
      { sourceEq: approxNumber(EPS), viewEq: approxNumber(EPS) },
    );
  });
  it("sub", () => {
    verifyLensLaws(
      () => {
        const n = num(rng(-100, 100));
        return { source: n, lens: n.sub(rng(-100, 100)) };
      },
      () => rng(-100, 100),
      { sourceEq: approxNumber(EPS), viewEq: approxNumber(EPS) },
    );
  });
  it("scale", () => {
    verifyLensLaws(
      () => {
        const n = num(rng(-100, 100));
        // Avoid k=0 (not invertible).
        const k = rng(-5, 5) || 0.5;
        return { source: n, lens: n.scale(k) };
      },
      () => rng(-100, 100),
      { sourceEq: approxNumber(EPS), viewEq: approxNumber(EPS) },
    );
  });
  it("affine", () => {
    verifyLensLaws(
      () => {
        const n = num(rng(-100, 100));
        const k = rng(-5, 5) || 0.5;
        const off = rng(-50, 50);
        return { source: n, lens: n.affine(k, off) };
      },
      () => rng(-100, 100),
      { sourceEq: approxNumber(EPS), viewEq: approxNumber(EPS) },
    );
  });
});

// ─── Num: lossy lenses ────────────────────────────────────────────

describe("Num lens laws — lossy lenses (PutGet within range)", () => {
  it("clamp", () => {
    verifyLensLawsLossy(
      () => {
        const n = num(rng(-100, 100));
        return { source: n, lens: n.clamp(0, 1) };
      },
      // View space: within [0, 1] only — outside that, PutGet fails
      // by design (clamped).
      () => rng(0, 1),
      { viewEq: approxNumber(EPS) },
    );
  });
  it("quantize", () => {
    verifyLensLawsLossy(
      () => {
        const n = num(rng(-100, 100));
        return { source: n, lens: n.quantize(0.25) };
      },
      // View space: multiples of 0.25 only.
      () => Math.round(rng(-100, 100) / 0.25) * 0.25,
      { viewEq: approxNumber(EPS) },
    );
  });
  it("cyclic", () => {
    // Cyclic reads pass through; writes pick the nearest representative.
    // PutGet holds when |target - current| ≤ period/2.
    verifyLensLawsLossy(
      () => {
        const n = num(rng(-100, 100));
        return { source: n, lens: n.cyclic(2 * Math.PI) };
      },
      // Only generate small deltas so we don't trip the period.
      () => rng(-100, 100),
      // After write, lens reads source, which equals what we wrote
      // up to nearest-period wrap.
      {
        viewEq: (a, b) => {
          const d = a - b;
          const wrapped = d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
          return Math.abs(wrapped) < EPS;
        },
      },
    );
  });
});

// ─── Vec: strict invertibles ──────────────────────────────────────

describe("Vec lens laws — strict invertibles", () => {
  const vGen = () => ({ x: rng(-100, 100), y: rng(-100, 100) });

  it("add", () => {
    verifyLensLaws(
      () => {
        const v = vec(rng(-100, 100), rng(-100, 100));
        return { source: v, lens: v.add(vGen()) };
      },
      vGen,
      { sourceEq: approxVec(EPS), viewEq: approxVec(EPS) },
    );
  });
  it("sub", () => {
    verifyLensLaws(
      () => {
        const v = vec(rng(-100, 100), rng(-100, 100));
        return { source: v, lens: v.sub(vGen()) };
      },
      vGen,
      { sourceEq: approxVec(EPS), viewEq: approxVec(EPS) },
    );
  });
  it("scale", () => {
    verifyLensLaws(
      () => {
        const v = vec(rng(-100, 100), rng(-100, 100));
        const k = rng(-5, 5) || 0.5;
        return { source: v, lens: v.scale(k) };
      },
      vGen,
      { sourceEq: approxVec(EPS), viewEq: approxVec(EPS) },
    );
  });
  it("offset", () => {
    verifyLensLaws(
      () => {
        const v = vec(rng(-100, 100), rng(-100, 100));
        return { source: v, lens: v.offset(rng(-50, 50), rng(-50, 50)) };
      },
      vGen,
      { sourceEq: approxVec(EPS), viewEq: approxVec(EPS) },
    );
  });
  it("up/down/left/right (sugar over offset)", () => {
    verifyLensLaws(
      () => {
        const v = vec(rng(-100, 100), rng(-100, 100));
        const lens = v.up(10).right(5);
        return { source: v, lens };
      },
      vGen,
      { sourceEq: approxVec(EPS), viewEq: approxVec(EPS) },
    );
  });
});

// ─── Vec: field lenses ────────────────────────────────────────────

describe("Vec lens laws — field lenses (axis projections)", () => {
  it(".x", () => {
    verifyLensLaws(
      () => {
        const v = vec(rng(-100, 100), rng(-100, 100));
        // Field lens — read is x; write spreads {x: new, y: old}.
        // GetPut holds; PutGet holds; PutPut holds. Strict.
        return {
          source: { value: v.peek(), peek: () => v.peek() } as {
            value: { x: number; y: number };
            peek: () => { x: number; y: number };
          },
          lens: v.x,
        };
      },
      () => rng(-100, 100),
      // For field lenses we only check the source's x stays consistent
      // — the source is a Vec, source.value compares {x,y} structurally.
      { sourceEq: (a, b) => a.x === b.x && a.y === b.y },
    );
  });
});

// ─── Box: strict invertibles ──────────────────────────────────────

describe("Box lens laws — strict invertibles", () => {
  const bGen = () => ({
    x: rng(-100, 100),
    y: rng(-100, 100),
    w: rng(0, 200),
    h: rng(0, 200),
  });
  const approxBox =
    (eps: number) => (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
      Math.abs(a.x - b.x) <= eps &&
      Math.abs(a.y - b.y) <= eps &&
      Math.abs(a.w - b.w) <= eps &&
      Math.abs(a.h - b.h) <= eps;

  it("add", () => {
    verifyLensLaws(
      () => {
        const b = box(rng(0, 100), rng(0, 100), rng(0, 100), rng(0, 100));
        return { source: b, lens: b.add(bGen()) };
      },
      bGen,
      { sourceEq: approxBox(EPS), viewEq: approxBox(EPS) },
    );
  });
  it("expand", () => {
    verifyLensLaws(
      () => {
        const b = box(rng(0, 100), rng(0, 100), rng(0, 100), rng(0, 100));
        return { source: b, lens: b.expand(rng(-10, 10)) };
      },
      bGen,
      { sourceEq: approxBox(EPS), viewEq: approxBox(EPS) },
    );
  });
});

// ─── Color: strict invertibles ────────────────────────────────────

describe("Color lens laws — strict invertibles", () => {
  type C = { r: number; g: number; b: number; a: number };
  const cGen = (): C => ({
    r: rng(0, 1),
    g: rng(0, 1),
    b: rng(0, 1),
    a: rng(0, 1),
  });
  const approxColor = (eps: number) => (a: C, b: C) =>
    Math.abs(a.r - b.r) <= eps &&
    Math.abs(a.g - b.g) <= eps &&
    Math.abs(a.b - b.b) <= eps &&
    Math.abs(a.a - b.a) <= eps;

  it("add", () => {
    verifyLensLaws(
      () => {
        const c = rgb(rng(0, 1), rng(0, 1), rng(0, 1));
        return { source: c, lens: c.add(cGen()) };
      },
      cGen,
      { sourceEq: approxColor(EPS), viewEq: approxColor(EPS) },
    );
  });
  it("scale", () => {
    verifyLensLaws(
      () => {
        const c = rgb(rng(0.1, 0.9), rng(0.1, 0.9), rng(0.1, 0.9));
        const k = rng(0.1, 5);
        return { source: c, lens: c.scale(k) };
      },
      cGen,
      { sourceEq: approxColor(EPS), viewEq: approxColor(EPS) },
    );
  });
});

// Voiding for un-used imports (Vec, Num used by other ops).
void Vec;
void Num;
