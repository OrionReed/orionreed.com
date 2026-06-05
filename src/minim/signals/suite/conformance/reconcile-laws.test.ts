// The bireactive laws, run against the recursive reconciliation prototype.
// This is the "real" conformance for the new backward architecture (vs the
// ad-hoc check() scenarios in _proto). Correctness laws (lens laws, soundness,
// confluence, lossy) must pass. Minimality/glitch depend on a minimal forward
// core, which the prototype deliberately lacks — kept here as informative.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reconcile as rx } from "../adapters/reconcile";
import { orderIndependent } from "../laws/confluence";
import { backwardDiamond } from "../laws/glitch";
import type { LensSpec } from "../laws/lens-laws";
import { getPut, putGet, putPut } from "../laws/lens-laws";
import { lossyChainAbsorbsNoop, lossyChainInRange } from "../laws/lossy";
import {
  chainScaling,
  chainWriteCost,
  noopWriteCost,
  reconvergeWriteCost,
} from "../laws/minimality";
import { chainNoLostWrite, faninNoLostWrite, treeNoLostWrite } from "../laws/soundness";

const RUNS = { numRuns: 200 } as const;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

describe("reconcile — lens laws (affine iso)", () => {
  const spec: LensSpec<number, number> = {
    rx,
    build: (r, init) => {
      const source = r.signal(init);
      const view = r.lens(
        source,
        x => x * 2 + 3,
        v => (v - 3) / 2,
      );
      return { source, view };
    },
    initSource: fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }),
    viewWrite: fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }),
  };
  it("GetPut", () => fc.assert(getPut(spec), RUNS));
  it("PutGet", () => fc.assert(putGet(spec), RUNS));
  it("PutPut", () => fc.assert(putPut(spec), RUNS));
});

describe("reconcile — lens laws (lossy clamp, PutGet in range)", () => {
  const spec: LensSpec<number, number> = {
    rx,
    build: (r, init) => {
      const source = r.signal(init);
      const view = r.lens(
        source,
        x => clamp(x, 0, 10),
        v => clamp(v, 0, 10),
      );
      return { source, view };
    },
    initSource: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
    viewWrite: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
  };
  it("PutGet (in-range)", () => fc.assert(putGet(spec), RUNS));
});

describe("reconcile — backward soundness (no lost writes)", () => {
  it("random affine chains read back exactly", () => fc.assert(chainNoLostWrite(rx), RUNS));
  it("random fan-ins read back exactly", () => fc.assert(faninNoLostWrite(rx), RUNS));
  it("random mixed trees read back exactly", () => fc.assert(treeNoLostWrite(rx), RUNS));
});

describe("reconcile — confluence", () => {
  it("batched writes to disjoint sources are order-independent", () =>
    fc.assert(orderIndependent(rx), RUNS));
});

describe("reconcile — lossy composition (clamp chain)", () => {
  it("in-range writes survive the chain", () => fc.assert(lossyChainInRange(rx), RUNS));
  it("settled re-write commits no source change", () => fc.assert(lossyChainAbsorbsNoop(rx), RUNS));
});

describe("reconcile — minimality (informative; naive forward core)", () => {
  it("1→1 chain: D bwd calls, 1 change, 1 fire", () => {
    for (const d of [1, 3, 8]) {
      const cost = chainWriteCost(rx, d, 42);
      expect(cost).toMatchObject({ bwd: d, changes: 1, fires: 1 });
    }
  });
  it("no-op re-write: 0 changes, 0 fires", () => {
    expect(noopWriteCost(rx, 5)).toMatchObject({ changes: 0, fires: 0 });
  });
  it("N→M fan-in: 1 bwd call, N changes, 1 fire", () => {
    for (const n of [2, 4, 7]) {
      expect(reconvergeWriteCost(rx, n, 100)).toMatchObject({ bwd: 1, changes: n, fires: 1 });
    }
  });
  it("scaling: backward work stays linear in depth", () => fc.assert(chainScaling(rx), RUNS));
});

describe("reconcile — backward glitch-freedom (diamond)", () => {
  it("fan-out write reconverges with one consistent downstream fire", () => {
    for (const n of [2, 3, 5]) {
      const r = backwardDiamond(rx, n, 30);
      expect(r.fires).toBe(1);
      expect(r.observations.every(Boolean)).toBe(true);
      expect(Math.abs(r.finalTotal - r.expectedTotal)).toBeLessThan(1e-9);
    }
  });
});
