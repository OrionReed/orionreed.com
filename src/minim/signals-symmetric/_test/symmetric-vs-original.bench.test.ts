// symmetric-vs-original.bench.test.ts — head-to-head perf of the
// symmetric port against the original lens for the four trap-class
// lenses we ported. We import from BOTH folders by relative path
// (note the trailing `signals` import is sibling-relative).
//
// What we care about:
//   - Read overhead: symmetric does an extra slice() + per-point unit
//     refresh in putr. Cost should be small (1.x×, not order-of-magnitude).
//   - Write overhead: similarly small.
//   - Memoized read: should be essentially identical (engine just
//     returns the cached value; no putr/putl re-entry).
//   - Composed chains: a plain .scale(K) on top of a symmetric lens
//     should pay no extra cost vs. .scale(K) on the original.

import { describe, it } from "vitest";

// Symmetric (sandbox) lenses.
import { spreadOf as spreadOf_S } from "../lenses/domain-aggregates";
import {
  bestFitCircleLens as bestFitCircleLens_S,
  bestFitLineLens as bestFitLineLens_S,
  scaleAbout as scaleAbout_S,
} from "../lenses/closed-form-policies";
import { bboxLens as bboxLens_S } from "../lenses/factor-lens";
import { vec as vec_S } from "../values/vec";

// Original (production) lenses.
import { spreadOf as spreadOf_O } from "../../signals/lenses/domain-aggregates";
import {
  bestFitCircleLens as bestFitCircleLens_O,
  bestFitLineLens as bestFitLineLens_O,
  scaleAbout as scaleAbout_O,
} from "../../signals/lenses/closed-form-policies";
import { bboxLens as bboxLens_O } from "../../signals/lenses/factor-lens";
import { vec as vec_O } from "../../signals/values/vec";

const N = 10_000;

function timed(label: string, fn: () => void): number {
  // Warm-up.
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(60)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1e6) / N).toFixed(2)}ns/op)`,
  );
  return ms;
}

const PTS = [
  { x: 3, y: 0 },
  { x: 0, y: 3 },
  { x: -3, y: 0 },
  { x: 0, y: -3 },
  { x: 2, y: 2 },
  { x: -2, y: -2 },
];

describe("bench: spreadOf — symmetric vs original", () => {
  it("read (parents change every iteration → forced re-eval)", () => {
    const cellsO = PTS.map(p => vec_O(p.x, p.y));
    const spreadO = spreadOf_O(cellsO as never);
    const cellsS = PTS.map(p => vec_S(p.x, p.y));
    const spreadS = spreadOf_S(cellsS as never);

    timed("spreadOf.value × N (original)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsO[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += spreadO.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("spreadOf.value × N (symmetric)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsS[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += spreadS.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });

  it("write × N (each ratio-driven update through the lens)", () => {
    const cellsO = PTS.map(p => vec_O(p.x, p.y));
    const spreadO = spreadOf_O(cellsO as never);
    const cellsS = PTS.map(p => vec_S(p.x, p.y));
    const spreadS = spreadOf_S(cellsS as never);
    spreadO.peek();
    spreadS.peek();

    timed("spreadOf.value = … × N (original)", () => {
      for (let i = 0; i < N; i++) spreadO.value = 2 + (i % 5);
    });
    timed("spreadOf.value = … × N (symmetric)", () => {
      for (let i = 0; i < N; i++) spreadS.value = 2 + (i % 5);
    });
  });

  it("collapse-and-recover round-trip × N (the trap-busting case)", () => {
    const cellsO = PTS.map(p => vec_O(p.x, p.y));
    const spreadO = spreadOf_O(cellsO as never);
    const cellsS = PTS.map(p => vec_S(p.x, p.y));
    const spreadS = spreadOf_S(cellsS as never);
    spreadO.peek();
    spreadS.peek();

    timed("spread → 0 → T × N (original, NB: trap → eps clamp)", () => {
      for (let i = 0; i < N; i++) {
        spreadO.value = 0;
        spreadO.value = 3 + (i % 5);
      }
    });
    timed("spread → 0 → T × N (symmetric, true recovery)", () => {
      for (let i = 0; i < N; i++) {
        spreadS.value = 0;
        spreadS.value = 3 + (i % 5);
      }
    });
  });
});

describe("bench: scaleAbout — symmetric vs original", () => {
  it("read & write parity", () => {
    const cellsO = PTS.map(p => vec_O(p.x, p.y));
    const pivotO = vec_O(0, 0);
    const sO = scaleAbout_O(cellsO as never, pivotO);
    const cellsS = PTS.map(p => vec_S(p.x, p.y));
    const pivotS = vec_S(0, 0);
    const sS = scaleAbout_S(cellsS as never, pivotS);

    timed("scaleAbout.value × N (original)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsO[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += sO.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("scaleAbout.value × N (symmetric)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsS[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += sS.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("scaleAbout.value = T × N (original)", () => {
      for (let i = 0; i < N; i++) sO.value = 2 + (i % 5);
    });
    timed("scaleAbout.value = T × N (symmetric)", () => {
      for (let i = 0; i < N; i++) sS.value = 2 + (i % 5);
    });
  });
});

describe("bench: bestFitLineLens.direction — symmetric vs original", () => {
  it("read (the case where symmetric does an extra unwrap)", () => {
    const cellsO = PTS.map(p => vec_O(p.x, p.y));
    const { direction: dO } = bestFitLineLens_O(cellsO as never);
    const cellsS = PTS.map(p => vec_S(p.x, p.y));
    const { direction: dS } = bestFitLineLens_S(cellsS as never);

    timed("direction.value × N (original)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsO[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += dO.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("direction.value × N (symmetric, complement unwrap)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsS[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += dS.value;
      }
      if (s < -1e30) throw new Error("");
    });
  });
});

describe("bench: bestFitCircleLens.radius — symmetric vs original", () => {
  it("read & write parity", () => {
    const cellsO = PTS.map(p => vec_O(p.x, p.y));
    const { radius: rO } = bestFitCircleLens_O(cellsO as never);
    const cellsS = PTS.map(p => vec_S(p.x, p.y));
    const { radius: rS } = bestFitCircleLens_S(cellsS as never);

    timed("radius.value × N (original)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsO[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += rO.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("radius.value × N (symmetric)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsS[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += rS.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("radius.value = T × N (original)", () => {
      for (let i = 0; i < N; i++) rO.value = 2 + (i % 5);
    });
    timed("radius.value = T × N (symmetric)", () => {
      for (let i = 0; i < N; i++) rS.value = 2 + (i % 5);
    });
  });
});

describe("bench: bboxLens.size — symmetric vs original", () => {
  it("read & write parity", () => {
    const cellsO = PTS.map(p => vec_O(p.x, p.y));
    const { size: szO } = bboxLens_O(cellsO as never);
    const cellsS = PTS.map(p => vec_S(p.x, p.y));
    const { size: szS } = bboxLens_S(cellsS as never);

    timed("size.value × N (original)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsO[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += szO.value.x;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("size.value × N (symmetric)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsS[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += szS.value.x;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("size.value = … × N (original)", () => {
      for (let i = 0; i < N; i++) szO.value = { x: 5 + (i % 3), y: 4 + (i % 3) };
    });
    timed("size.value = … × N (symmetric)", () => {
      for (let i = 0; i < N; i++) szS.value = { x: 5 + (i % 3), y: 4 + (i % 3) };
    });
  });
});

describe("bench: composed chain — symmetric vs original", () => {
  it("spreadOf().scale(10) read & write", () => {
    const cellsO = PTS.map(p => vec_O(p.x, p.y));
    const spreadO = spreadOf_O(cellsO as never);
    const tenO = spreadO.scale(10);
    const cellsS = PTS.map(p => vec_S(p.x, p.y));
    const spreadS = spreadOf_S(cellsS as never);
    const tenS = spreadS.scale(10);

    timed("spread.scale(10).value × N (original)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsO[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += tenO.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("spread.scale(10).value × N (symmetric)", () => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        cellsS[0]!.value = { x: 3 + i * 0.001, y: 0 };
        s += tenS.value;
      }
      if (s < -1e30) throw new Error("");
    });
    timed("spread.scale(10).value = … × N (original)", () => {
      for (let i = 0; i < N; i++) tenO.value = 20 + (i % 5);
    });
    timed("spread.scale(10).value = … × N (symmetric)", () => {
      for (let i = 0; i < N; i++) tenS.value = 20 + (i % 5);
    });
  });
});
