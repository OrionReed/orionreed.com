// Throwaway debug — investigate why equilateral triangle solver
// doesn't fully converge in the basic test.

import { describe, expect, it } from "vitest";
import { num } from "../index";
import { _allClusters, relate } from "../relate";
import { dampedNewton } from "../solvers";

describe("debug — equilateral triangle solver", () => {
  it("direct dampedNewton on 3 constraints, 6 unknowns, no pins, init from textbook", () => {
    const x = [0, 0, 1, 0, 0.5, 1];
    const R = (xs: readonly number[], out: number[]) => {
      const [ax, ay, bx, by, cx, cy] = xs as readonly [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      out[0] = Math.hypot(ax - bx, ay - by) - 1;
      out[1] = Math.hypot(bx - cx, by - cy) - 1;
      out[2] = Math.hypot(cx - ax, cy - ay) - 1;
    };
    const result = dampedNewton(x, R, 3, [false, false, false, false, false, false], {
      maxIters: 64,
    });
    console.log(
      `direct: converged=${result.converged} iters=${result.iters} residual=${result.residual} x=${JSON.stringify(x)}`,
    );
    expect(result.converged).toBe(true);
  });

  it("incremental: rAB then rBC then rCA, log cluster state at each step", () => {
    const Ax = num(0);
    const Ay = num(0);
    const Bx = num(1);
    const By = num(0);
    const Cx = num(0.5);
    const Cy = num(1);

    const dist = (
      px: typeof Ax,
      py: typeof Ay,
      qx: typeof Bx,
      qy: typeof By,
      L: number,
      name: string,
    ) =>
      relate({
        name,
        cells: [px, py, qx, qy],
        residual: ([a, b, c, d], out) => {
          out[0] = Math.hypot(a! - c!, b! - d!) - L;
        },
        m: 1,
      });

    const rAB = dist(Ax, Ay, Bx, By, 1, "AB");
    console.log(
      `after AB: A=(${Ax.value.toFixed(3)},${Ay.value.toFixed(3)}) B=(${Bx.value.toFixed(3)},${By.value.toFixed(3)}) C=(${Cx.value.toFixed(3)},${Cy.value.toFixed(3)}) rAB=${rAB.residual.value}`,
    );
    const rBC = dist(Bx, By, Cx, Cy, 1, "BC");
    console.log(
      `after BC: A=(${Ax.value.toFixed(3)},${Ay.value.toFixed(3)}) B=(${Bx.value.toFixed(3)},${By.value.toFixed(3)}) C=(${Cx.value.toFixed(3)},${Cy.value.toFixed(3)}) rAB=${rAB.residual.value} rBC=${rBC.residual.value}`,
    );
    const rCA = dist(Cx, Cy, Ax, Ay, 1, "CA");
    console.log(
      `after CA: A=(${Ax.value.toFixed(3)},${Ay.value.toFixed(3)}) B=(${Bx.value.toFixed(3)},${By.value.toFixed(3)}) C=(${Cx.value.toFixed(3)},${Cy.value.toFixed(3)}) rAB=${rAB.residual.value} rBC=${rBC.residual.value} rCA=${rCA.residual.value}`,
    );
    console.log(`clusters: ${_allClusters().length}`);
    expect(rAB.residual.value).toBeLessThan(1e-4);
  });
});
