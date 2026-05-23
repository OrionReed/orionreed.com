// ab-aggregates.bench.test.ts — perf comparison between original
// signals/mix.ts + signals/argmin.ts and the prototype's fanin-based
// reimplementation in `aggregates.ts`.

import { describe, it } from "vitest";
import * as O from "@minim/signals";
import {
  argminNumLens,
  axesLens,
  centroidLens,
  meanLens,
  midpointLens,
  polarCircular,
} from "../aggregates";
import { Num as PNum, num as pnum, Vec as PVec, vec as pvec } from "../index";

const N = 50_000;

function timed(label: string, fn: () => void): number {
  fn();
  fn();
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  console.info(
    `  ${label.padEnd(58)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / N).toFixed(2)}µs/op)`,
  );
  return ms;
}

describe("bench A/B: 3-Num mean — read", () => {
  it("read", () => {
    const oA = O.num(1),
      oB = O.num(2),
      oC = O.num(3);
    const oMix = O.mix(O.Num, [oA, oB, oC], O.Mix.mean, O.Mix.deltaEven);

    const pA = pnum(1),
      pB = pnum(2),
      pC = pnum(3);
    const pMix = meanLens(PNum, [pA, pB, pC]);

    timed("ORIG mix(Num, mean) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        oA.value = i;
        s += oMix.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("PROTO meanLens(Num) read", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        pA.value = i;
        s += pMix.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });
});

describe("bench A/B: 3-Num mean — write (delta-even distribute)", () => {
  it("write", () => {
    const oA = O.num(1),
      oB = O.num(2),
      oC = O.num(3);
    const oMix = O.mix(O.Num, [oA, oB, oC], O.Mix.mean, O.Mix.deltaEven);

    const pA = pnum(1),
      pB = pnum(2),
      pC = pnum(3);
    const pMix = meanLens(PNum, [pA, pB, pC]) as PNum & { value: number };

    timed("ORIG mix(Num, mean, deltaEven) write", () => {
      for (let i = 0; i < N; i++) oMix.value = i * 0.1;
    });
    timed("PROTO meanLens(Num) write", () => {
      for (let i = 0; i < N; i++) pMix.value = i * 0.1;
    });
  });
});

describe("bench A/B: 4-Vec centroid — write (drag-translate)", () => {
  it("write", () => {
    const oVs = [O.vec(0, 0), O.vec(10, 0), O.vec(10, 10), O.vec(0, 10)];
    const oMix = O.mix(O.Vec, oVs, O.Mix.mean, O.Mix.deltaEven);

    const pVs = [pvec(0, 0), pvec(10, 0), pvec(10, 10), pvec(0, 10)];
    const pMix = centroidLens(pVs) as PVec & { value: { x: number; y: number } };

    timed("ORIG mix(Vec, mean, deltaEven) — 4 vecs write", () => {
      for (let i = 0; i < N; i++) oMix.value = { x: i, y: i };
    });
    timed("PROTO centroidLens — 4 vecs write", () => {
      for (let i = 0; i < N; i++) pMix.value = { x: i, y: i };
    });
  });
});

describe("bench A/B: midpoint (2-Vec) — write", () => {
  it("write", () => {
    const oA = O.vec(0, 0),
      oB = O.vec(10, 10);
    const oMix = O.mix(O.Vec, [oA, oB], O.Mix.mean, O.Mix.deltaEven);

    const pA = pvec(0, 0),
      pB = pvec(10, 10);
    const pMid = midpointLens(pA, pB) as PVec & { value: { x: number; y: number } };

    timed("ORIG mix(Vec, mean, deltaEven) — 2 vecs write", () => {
      for (let i = 0; i < N; i++) oMix.value = { x: i, y: i };
    });
    timed("PROTO midpointLens write", () => {
      for (let i = 0; i < N; i++) pMid.value = { x: i, y: i };
    });
  });
});

describe("bench A/B: axes(x, y) — write", () => {
  it("write", () => {
    const ox = O.num(0),
      oy = O.num(0);
    const oV = O.axes(ox, oy);

    const px = pnum(0),
      py = pnum(0);
    const pV = axesLens(px, py) as PVec & { value: { x: number; y: number } };

    timed("ORIG axes(x, y) write", () => {
      for (let i = 0; i < N; i++) oV.value = { x: i, y: i * 2 };
    });
    timed("PROTO axesLens write", () => {
      for (let i = 0; i < N; i++) pV.value = { x: i, y: i * 2 };
    });
  });
});

describe("bench A/B: polar circular — write", () => {
  it("write", () => {
    const oC = O.vec(0, 0),
      oR = O.num(10),
      oA = O.num(0);
    const oP = O.polar(oC, oR, oA, "circular");

    const pC = pvec(0, 0),
      pR = pnum(10),
      pA = pnum(0);
    const pP = polarCircular(pC, pR, pA) as PVec & { value: { x: number; y: number } };

    timed("ORIG polar 'circular' write", () => {
      for (let i = 0; i < N; i++) oP.value = { x: 5 + i * 0.001, y: 5 - i * 0.001 };
    });
    timed("PROTO polarCircular write", () => {
      for (let i = 0; i < N; i++) pP.value = { x: 5 + i * 0.001, y: 5 - i * 0.001 };
    });
  });
});

describe("bench A/B: argminNum (3-input) — write", () => {
  it("linear forward", () => {
    const oXs = [O.num(1), O.num(2), O.num(3)];
    const oR = O.argminNum(oXs, xs => xs[0]! + xs[1]! + xs[2]!, [1, 1, 1]);

    const pXs = [pnum(1), pnum(2), pnum(3)];
    const pR = argminNumLens(pXs, xs => xs[0]! + xs[1]! + xs[2]!, [1, 1, 1]);

    timed("ORIG argminNum (3-input linear) write", () => {
      for (let i = 0; i < N; i++) oR.value = i * 0.001;
    });
    timed("PROTO argminNumLens (3-input linear) write", () => {
      for (let i = 0; i < N; i++) pR.value = i * 0.001;
    });
  });
});
