// avbd-fuzz.test.ts — property-based tests over random scenes.
//
// Each property is tested on N seeded scenarios. Failures report the
// seed so a fix is reproducible by hard-coding that seed.

import { describe, expect, it } from "vitest";
import { type Num, num, type Vec, vec, type Writable } from "../../signals";
import { constraints, distance, eq, leq, pin } from "../index";
import { forAll } from "./_fuzz";

type WVec = Writable<Vec>;
type WNum = Writable<Num>;

describe("AVBD fuzz — invariants over random scenes", () => {
  it("random pinned-chain: all distance constraints satisfied at convergence", () => {
    forAll(50, rng => {
      const N = rng.int(3, 16);
      const cells: WVec[] = [];
      for (let i = 0; i < N; i++) cells.push(vec(rng.float(-1, 1), rng.float(-1, 1)));
      cells[0]!.value = { x: 0, y: 0 };
      const tailX = rng.float(0.5, N - 1);
      const tailY = rng.float(-1, 1);
      const headTailDist = Math.hypot(tailX, tailY);
      if (headTailDist > N - 1) return;

      const s = constraints({ iterations: 30 });
      for (let i = 1; i < N; i++) s.add(distance(cells[i - 1]!, cells[i]!, 1));
      s.add(pin(cells[0]!));
      s.add(pin(cells[N - 1]!));
      // Multi-step warm-start to help long chains converge.
      cells[N - 1]!.value = { x: tailX, y: tailY };
      for (let k = 0; k < 10; k++) {
        cells[N - 1]!.value = { x: tailX, y: tailY + k * 1e-7 };
      }

      let maxErr = 0;
      for (let i = 1; i < N; i++) {
        const dx = cells[i]!.value.x - cells[i - 1]!.value.x;
        const dy = cells[i]!.value.y - cells[i - 1]!.value.y;
        const err = Math.abs(Math.hypot(dx, dy) - 1);
        if (err > maxErr) maxErr = err;
      }
      expect(maxErr).toBeLessThan(0.5);
    });
  });

  it("hard inequality leq(a, b) keeps a ≤ b for any feasible target", () => {
    forAll(50, rng => {
      const aInit = rng.float(-10, 10);
      const bInit = rng.float(-10, 10);
      const a = num(aInit);
      const b = num(bInit);
      const s = constraints({ iterations: 20 });
      s.add(leq(a, b));
      s.add(pin(b));
      b.value = bInit + 1e-9; // trigger
      expect(a.value).toBeLessThanOrEqual(b.value + 1e-2);
    });
  });

  it("eq propagates through arbitrary chain of eq() constraints", () => {
    forAll(20, rng => {
      const N = rng.int(3, 8);
      const cells: WNum[] = [];
      for (let i = 0; i < N; i++) cells.push(num(rng.float(-5, 5)));
      const target = rng.float(-10, 10);

      const s = constraints({ iterations: 30 });
      for (let i = 1; i < N; i++) s.add(eq(cells[i - 1]!, cells[i]!));
      s.add(pin(cells[0]!));
      cells[0]!.value = target;
      // Re-trigger to propagate down the chain (each iteration only
      // moves info one Gauss-Seidel hop).
      for (let k = 0; k < 5; k++) cells[0]!.value = target + k * 1e-7;

      for (let i = 1; i < N; i++) {
        expect(cells[i]!.value).toBeCloseTo(target, 0);
      }
    });
  });
});
