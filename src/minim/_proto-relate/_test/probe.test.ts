// Probe to figure out why hard-pinned A doesn't snap C onto circles.
import { describe, expect, it } from "vitest";
import { onCircle, pinPoint, point } from "../constraints";
import { _allClusters, clusterHealth, isHardPinned } from "../relate";
import { num } from "../index";

describe("probe", () => {
  it("hardPin status + cluster after onCircle", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    pinPoint(A);
    pinPoint(B);
    console.log(
      `after pinPoint: A.x hardPinned=${isHardPinned(A.x)} A.y=${isHardPinned(A.y)} B.x=${isHardPinned(B.x)} B.y=${isHardPinned(B.y)}`,
    );
    const C = point(num(0.5), num(1));
    onCircle(C, A, 1);
    console.log(
      `after onCircle 1: C=(${C.x.value},${C.y.value}) clusters=${_allClusters().length}`,
    );
    const cl = clusterHealth(C.x);
    console.log(`cluster health: ${cl ? JSON.stringify(cl.value) : "none"}`);

    onCircle(C, B, 1);
    console.log(
      `after onCircle 2: C=(${C.x.value},${C.y.value}) |CA|=${Math.hypot(C.x.value - A.x.value, C.y.value - A.y.value)} |CB|=${Math.hypot(C.x.value - B.x.value, C.y.value - B.y.value)}`,
    );
    expect(true).toBe(true);
  });
});
