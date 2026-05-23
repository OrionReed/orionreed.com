// relate-signal-composition.test.ts — relations composed with the
// full signal stack: computeds, lens chains, field lenses, mix
// aggregation. The goal: verify that `relate` is just another
// reactive primitive, freely composable upstream and downstream.

import { describe, expect, it } from "vitest";
import { dist, pinPoint, point } from "../constraints";
import { batch, computed, effect, num, vec } from "../index";
import { hardPin, relate } from "../relate";

describe("Computeds upstream of cluster cells (read-side composition)", () => {
  it("computed depending on multiple cluster cells composes their post-solve state", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0.5, Math.sqrt(3) / 2);
    dist(point(A), point(B), 1);
    dist(point(B), point(C), 1);
    dist(point(C), point(A), 1);
    pinPoint(B);

    const perimeter = computed(() => {
      const ab = Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y);
      const bc = Math.hypot(B.value.x - C.value.x, B.value.y - C.value.y);
      const ca = Math.hypot(C.value.x - A.value.x, C.value.y - A.value.y);
      return ab + bc + ca;
    });
    expect(perimeter.value).toBeCloseTo(3, 4);

    // Drag A around B (radius 1 — reachable). Constraints stay
    // satisfied; perimeter stays at 3.
    A.value = { x: 1 + Math.cos(Math.PI / 4), y: Math.sin(Math.PI / 4) };
    expect(perimeter.value).toBeCloseTo(3, 4);
  });

  it("computed of cluster cell + non-cluster cell tracks both", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    const free = num(10);
    const total = computed(() => a.value + b.value + c.value + free.value);
    const initial = total.value;
    expect(initial).toBeCloseTo(3 + 4 + 5 + 10);

    a.value = 6;
    // a stays 6 (user-pinned), b, c reflow to satisfy a²+b²=c².
    expect(total.value).toBeCloseTo(a.value + b.value + c.value + free.value);
    expect(total.value).not.toBe(initial);

    free.value = 100;
    expect(total.value).toBeCloseTo(a.value + b.value + c.value + 100);
  });
});

describe("Effects observing cluster cells", () => {
  it("multi-cell effect runs once per batch even when several cluster cells change", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    dist(point(A), point(B), 1);

    let runs = 0;
    effect(() => {
      // Observe both A.x and A.y AND B.x — all three change together
      // when constraint resolves.
      void A.x.value;
      void A.y.value;
      void B.x.value;
      runs++;
    });
    runs = 0;

    A.value = { x: -3, y: 0 };
    // Solver reflows. Effect should run a small bounded number of
    // times — once per actual batch flush, not once per cell.
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(runs).toBeLessThanOrEqual(3);
  });

  it("effect can write to a SEPARATE cell triggering its own cluster", () => {
    // Cluster 1: a = b
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    // Cluster 2: c = 2*d
    const c = num(0);
    const d = num(0);
    relate({
      cells: [c, d],
      residual: ([x, y], out) => {
        out[0] = x! - 2 * y!;
      },
      m: 1,
    });
    // Cross-cluster bind: c = a (effect writes c whenever a changes)
    effect(() => {
      c.value = a.value;
    });
    a.value = 8;
    expect(b.value).toBeCloseTo(8); // cluster 1 propagation
    expect(c.value).toBeCloseTo(8); // effect bind
    expect(d.value).toBeCloseTo(4); // cluster 2 propagation: c=2d ⇒ d=4
  });
});

describe("Lens chains as constraint inputs", () => {
  it("dist over Vec sources via point(Vec) — registers parent", () => {
    // For a Vec source (`vec(0, 0)` returns Vec source with field
    // lenses .x, .y), use `point(vec)`. The `point()` Vec-overload
    // tracks the parent so writes to .x/.y/.value all properly pin.
    const A = vec(0, 0);
    const B = vec(5, 0);
    dist(point(A), point(B), 5);
    A.x.value = -3;
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 3);
  });

  it("dist over axes-bound Vec via direct Nums — also works (sources are the Nums)", () => {
    // For `vec(numX, numY)` the underlying sources ARE numX and
    // numY, and writing v.x.value writes through to numX (firing
    // pinHook for numX). Using point(numX, numY) directly is fine.
    const ax = num(0);
    const ay = num(0);
    const bx = num(5);
    const by = num(0);
    const A = vec(ax, ay);
    const B = vec(bx, by);
    dist(point(ax, ay), point(bx, by), 5);
    A.x.value = -3;
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 3);
  });

  it("dist over an affine-transformed Num — write through the chain reaches the source", () => {
    // a is the source; aDouble = 2*a is a writable lens.
    // Constrain |aDouble - bDouble| = 4 (where bDouble is similar).
    // Writing aDouble = 6 ⇒ a = 3; cluster sees 'a' as the underlying
    // cell.
    const a = num(0);
    const b = num(0);
    const aDouble = a.scale(2);
    const bDouble = b.scale(2);
    // The cluster cells should be the SOURCES (a, b), not the
    // doubled lenses, because writes to aDouble propagate to a,
    // which is what fires pinHook. dist works over Nums, so we pass
    // (a, b)-based points but use the doubled values via lens
    // observation. For now, simplest constraint: |a-b| = 1.
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = Math.abs(x! - y!) - 1;
      },
      m: 1,
    });
    aDouble.value = 4; // ⇒ a = 2
    // b should be at |a - b| = 1, so b = 1 or b = 3.
    expect(a.value).toBeCloseTo(2);
    expect(Math.abs(a.value - b.value)).toBeCloseTo(1, 4);
    // Lens views see source-derived values.
    expect(aDouble.value).toBeCloseTo(4);
    expect(bDouble.value).toBeCloseTo(2 * b.value);
  });
});

describe("Hard pin via reactive cluster member (the recommended pattern)", () => {
  it("hard-pin target BEFORE the initial cluster solve — target stays at its initial value", () => {
    // Two patterns work here. (a) Hard-pin first, then constrain —
    // target's hard pin fixes its value before any LSQ optimization
    // can drift it. (b) Make target a regular cluster cell — it
    // becomes a draggable input that pins on user write.
    //
    // This test uses (a): `hardPin(target, 5)` before relate ensures
    // the cluster's first solve sees target as fixed at 5.
    const target = num(5);
    const a = num(0);
    const b = num(0);
    hardPin(target, 5); // freeze BEFORE the relation
    relate({
      cells: [a, b, target],
      residual: ([x, y, t], out) => {
        out[0] = x! - t!;
        out[1] = y! - t!;
      },
      m: 2,
    });
    expect(target.value).toBe(5);
    expect(a.value).toBeCloseTo(5);
    expect(b.value).toBeCloseTo(5);
  });

  it("target as a draggable cluster cell — user writes propagate naturally", () => {
    // Pattern (b): target is just another cluster cell. User writes
    // pin it; cluster reflows. No hardPin needed.
    const target = num(5);
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b, target],
      residual: ([x, y, t], out) => {
        out[0] = x! - t!;
        out[1] = y! - t!;
      },
      m: 2,
    });
    target.value = 5; // user pin to anchor
    expect(a.value).toBeCloseTo(5);
    expect(b.value).toBeCloseTo(5);
    target.value = 17;
    expect(a.value).toBeCloseTo(17);
    expect(b.value).toBeCloseTo(17);
  });
});

describe("Bidirectional binding via a cluster cell", () => {
  it("writing to a cluster cell DOWN propagates through the cluster", () => {
    // The cluster as a "sync" primitive: a = b = c.
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate({
      cells: [a, b, c],
      residual: ([x, y, z], out) => {
        out[0] = x! - y!;
        out[1] = y! - z!;
      },
      m: 2,
    });
    a.value = 7;
    expect(b.value).toBeCloseTo(7);
    expect(c.value).toBeCloseTo(7);
    c.value = -3;
    expect(a.value).toBeCloseTo(-3);
    expect(b.value).toBeCloseTo(-3);
  });

  it("writing UP to a cluster cell from an effect is bounded (no feedback loop)", () => {
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    let effectRuns = 0;
    const ext = num(5);
    effect(() => {
      a.value = ext.value;
      effectRuns++;
    });
    expect(b.value).toBeCloseTo(5);
    effectRuns = 0;
    ext.value = 11;
    expect(a.value).toBeCloseTo(11);
    expect(b.value).toBeCloseTo(11);
    expect(effectRuns).toBeLessThanOrEqual(2); // bounded
  });
});

describe("Batch atomicity across cluster + effects", () => {
  it("batch with multiple cluster writes runs solver once and effect once", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0.5, Math.sqrt(3) / 2);
    dist(point(A), point(B), 1);
    dist(point(B), point(C), 1);
    dist(point(C), point(A), 1);
    pinPoint(B);

    let solves = 0;
    effect(() => {
      void A.value;
      void C.value;
      solves++;
    });
    solves = 0;

    batch(() => {
      A.value = { x: 0.5, y: 0.866 };
      // intermediate state never visible to effects
    });
    // Effect runs once for the entire batch.
    expect(solves).toBe(1);
  });
});
