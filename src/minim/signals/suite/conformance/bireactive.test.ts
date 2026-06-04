// Bireactive laws — the surface with no forward analogue. Lens laws
// (local algebra of a write-through), backward minimality (no redundant
// backward work), backward glitch-freedom (the cross-framework
// discriminator), confluence, and no-lost-write soundness. All phrased
// against the adapter, so they would run unchanged on any bireactive
// engine.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { minim } from "../adapters/minim";
import type { Reactive, Source, View } from "../adapters/types";
import { orderIndependent } from "../laws/confluence";
import { backwardDiamond } from "../laws/glitch";
import { getPut, type LensSpec, putGet, putPut } from "../laws/lens-laws";
import {
  chainScaling,
  chainWriteCost,
  noopWriteCost,
  reconvergeWriteCost,
} from "../laws/minimality";
import { chainNoLostWrite, faninNoLostWrite } from "../laws/soundness";

const RUNS = { numRuns: 200 } as const;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ─── Lens laws ──────────────────────────────────────────────────────

describe("lens laws — very-well-behaved (affine iso)", () => {
  const spec: LensSpec<number, number> = {
    rx: minim,
    build: (rx, init) => {
      const source = rx.signal(init);
      const view = rx.lens(
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

describe("lens laws — lossy (clamp), PutGet within range only", () => {
  const spec: LensSpec<number, number> = {
    rx: minim,
    build: (rx, init) => {
      const source = rx.signal(init);
      const view = rx.lens(
        source,
        x => clamp(x, 0, 10),
        v => clamp(v, 0, 10),
      );
      return { source, view };
    },
    initSource: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
    viewWrite: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
  };

  it("PutGet (in-range writes read back exactly)", () => fc.assert(putGet(spec), RUNS));
});

// ─── Minimality ─────────────────────────────────────────────────────

describe("backward minimality", () => {
  it("1→1 chain: exactly `depth` bwd calls, one source change, one fire", () => {
    for (const d of [1, 3, 8]) {
      const cost = chainWriteCost(minim, d, 42);
      expect(cost.bwd).toBe(d);
      expect(cost.changes).toBe(1);
      expect(cost.fires).toBe(1);
    }
  });

  it("no-op re-write: zero source changes, zero fires", () => {
    const cost = noopWriteCost(minim, 5);
    expect(cost.changes).toBe(0);
    expect(cost.fires).toBe(0);
  });

  it("N→M fan-in: one bwd call, N source changes, one downstream fire", () => {
    for (const n of [2, 4, 7]) {
      const cost = reconvergeWriteCost(minim, n, 100);
      expect(cost.bwd).toBe(1);
      expect(cost.changes).toBe(n);
      expect(cost.fires).toBe(1);
    }
  });

  it("scaling: backward work stays linear in depth", () => fc.assert(chainScaling(minim), RUNS));
});

// ─── Glitch-freedom (backward diamond) ──────────────────────────────

describe("backward glitch-freedom", () => {
  it("fan-out write reconverges with a single consistent downstream fire", () => {
    for (const n of [2, 3, 5]) {
      const r = backwardDiamond(minim, n, 30);
      expect(r.fires).toBe(1);
      expect(r.observations.every(Boolean)).toBe(true);
      expect(Math.abs(r.finalTotal - r.expectedTotal)).toBeLessThan(1e-9);
    }
  });
});

// ─── Confluence ─────────────────────────────────────────────────────

describe("confluence", () => {
  it("batched writes to disjoint sources are order-independent", () =>
    fc.assert(orderIndependent(minim), RUNS));
});

// ─── Soundness ──────────────────────────────────────────────────────

describe("backward soundness (no lost writes)", () => {
  it("random affine chains read back exactly", () => fc.assert(chainNoLostWrite(minim), RUNS));
  it("random fan-ins read back exactly", () => fc.assert(faninNoLostWrite(minim), RUNS));
});

// Keep the adapter types referenced for readers of this file.
void (null as unknown as [Reactive, Source<number>, View<number>]);
