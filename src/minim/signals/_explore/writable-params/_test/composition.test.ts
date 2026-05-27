// composition.test.ts — chains of writable-param lenses.
//
// We're testing: do writes cascade cleanly through nested writable-param
// lenses? Does the writability inference at the type level keep working?
// Does the bwd see consistent (fresh) parent values at every level?

import { describe, expect, it } from "vitest";
import { batch, num, type Num, Vec, vec, type Writable } from "../../../index";
import { clampStretch, numAddW, vecRightW } from "../wp";

describe("two-level chain: vecRightW(vecRightW(a, n1), n2)", () => {
  it("forward propagation: changing innermost affects outermost", () => {
    const a = vec(10, 20);
    const n1 = num(5);
    const n2 = num(7);
    const b = vecRightW(a, n1); // b.x = a.x + n1 = 15
    const c = vecRightW(b, n2); // c.x = b.x + n2 = 22
    expect(c.value).toEqual({ x: 22, y: 20 });

    n1.value = 100;
    expect(c.value).toEqual({ x: 117, y: 20 });
    n2.value = 200;
    expect(c.value).toEqual({ x: 310, y: 20 });
  });

  it("backward cascade: writing c writes n2 (b absorbs nothing); n1 stays", () => {
    const a = vec(10, 20);
    const n1 = num(5);
    const n2 = num(7);
    const b = vecRightW(a, n1);
    const c = vecRightW(b, n2);
    expect(c.value).toEqual({ x: 22, y: 20 });

    c.value = { x: 100, y: 25 };
    // c.bwd: a (b's stand-in) anchored in x, n2 absorbs (100 - b.x) = (100 - 15) = 85
    // But wait — b.x is itself a derived value. When c.bwd writes "b unchanged", it
    // tries to write b's current value back into b — which routes to b.bwd → (a, n1).
    // Re-writing b's CURRENT value is a no-op for the GP-law lenses.
    expect(c.value).toEqual({ x: 100, y: 25 });
    expect(n2.peek()).toBe(85);
    expect(n1.peek()).toBe(5); // unchanged
    expect(a.peek()).toEqual({ x: 10, y: 25 }); // a.y updated to 25
  });

  it("PutGet through the chain", () => {
    const a = vec(10, 20);
    const n1 = num(5);
    const n2 = num(7);
    const b = vecRightW(a, n1);
    const c = vecRightW(b, n2);
    for (const target of [
      { x: 0, y: 0 },
      { x: -100, y: 50 },
      { x: 1000, y: -50 },
    ]) {
      c.value = target;
      expect(c.value).toEqual(target);
    }
  });
});

describe("anonymous nested writable param: vecRightW(a, num())", () => {
  it("fresh inline num acts as private slack", () => {
    const a = vec(10, 20);
    const slack = num(5); // anonymous in spirit (no other reference)
    const b = vecRightW(a, slack);
    b.value = { x: 100, y: 25 };
    expect(b.value).toEqual({ x: 100, y: 25 });
    expect(a.peek()).toEqual({ x: 10, y: 25 });
    expect(slack.peek()).toBe(90);
  });
});

describe("mixing wp lenses with regular read-only lenses", () => {
  it("regular .right(k) on top of vecRightW: outer write writes only k's source semantics?", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n); // b = (15, 20)
    const c = b.right(7); // c = (22, 20); k is a literal — purely RO
    expect(c.value).toEqual({ x: 22, y: 20 });

    c.value = { x: 100, y: 25 };
    // c's bwd (regular .right) writes (100 - 7, 25) = (93, 25) back to b
    // b's bwd (vecRightW) sees target (93, 25) → n := 93 - 10 = 83; a.y := 25
    expect(b.value).toEqual({ x: 93, y: 25 });
    expect(a.peek()).toEqual({ x: 10, y: 25 });
    expect(n.peek()).toBe(83);
    expect(c.value).toEqual({ x: 100, y: 25 });
  });

  it("wp lens taking a clamped reactive param as the writable", () => {
    // n is itself a writable lens (clamp). The param to vecRightW is the
    // clamp view. Dragging the result back-routes into n via the clamp's bwd.
    const a = vec(10, 20);
    const raw = num(5);
    const clamped = raw.clamp(0, 100);
    const b = vecRightW(a, clamped);

    expect(b.value).toEqual({ x: 15, y: 20 });

    b.value = { x: 60, y: 20 };
    // clamped := 50 → raw := 50 (in range, no projection)
    expect(raw.peek()).toBe(50);
    expect(b.value).toEqual({ x: 60, y: 20 });

    // Now push outside the clamp range: clamped = 200 projects to 100.
    b.value = { x: 210, y: 20 };
    // n.value = 200; clamp projects writes too (clamp's bwd is the
    // same projection), so raw := 100.
    expect(raw.peek()).toBe(100);
    // Read of b reads through the clamp → b.x = a.x + clamp(raw) = 10 + 100 = 110.
    // NB: this VIOLATES PutGet (we wrote 210, read 110) — but it's the
    // expected behavior of a lossy lens. clamp's documented contract says so.
    expect(b.value).toEqual({ x: 110, y: 20 });
  });
});

describe("clampStretch as a participant in larger compositions", () => {
  it("clampStretch's output fed into a sum: writes cascade", () => {
    const t = num(5);
    const lo = num(0);
    const hi = num(10);
    const view = clampStretch(t, lo, hi);

    const extra = num(100);
    const total = numAddW(view as unknown as Writable<Num>, extra, 0.5);

    // total = clampedView + extra = 5 + 100 = 105
    expect(total.value).toBe(105);

    // Write total = 125: delta = 20; split 50/50.
    // view gets +10 → write 15 to view. Since 15 is in [0,10] range, NO wait
    // 15 is OUTSIDE [0,10]; clampStretch policy expands hi to 15.
    // extra gets +10 → 110.
    total.value = 125;
    expect(extra.peek()).toBe(110);
    expect(t.peek()).toBe(15);
    expect(hi.peek()).toBe(15); // stretched
    expect(lo.peek()).toBe(0); // unchanged
    expect(total.value).toBe(125);
  });
});

describe("deep cascade: 5-level chain", () => {
  it("dragging the leaf cascades through 5 levels of slack", () => {
    const a = vec(0, 0);
    const slacks: Writable<Num>[] = [num(1), num(2), num(3), num(4), num(5)];
    let v = a as Writable<Vec>;
    for (const s of slacks) v = vecRightW(v, s);
    expect(v.value).toEqual({ x: 15, y: 0 }); // 0 + 1+2+3+4+5 = 15

    v.value = { x: 1000, y: 50 };
    // a.x anchored (each layer anchors its previous-stage); top slack absorbs.
    // Layer 5 (top) policy: previous stage (sum 0+1+2+3+4=10) stays in x; slack5 := 1000-10 = 990
    expect(a.peek()).toEqual({ x: 0, y: 50 });
    expect(slacks[0]!.peek()).toBe(1);
    expect(slacks[1]!.peek()).toBe(2);
    expect(slacks[2]!.peek()).toBe(3);
    expect(slacks[3]!.peek()).toBe(4);
    expect(slacks[4]!.peek()).toBe(990); // absorbed everything
    expect(v.value).toEqual({ x: 1000, y: 50 });
  });
});

describe("writability inference (type-level smoke test)", () => {
  it("vecRightW returns Writable<Vec> and stays writable through regular method chain", () => {
    const a = vec(0, 0);
    const n = num(0);
    const b = vecRightW(a, n);
    // Type-level: assignment must compile (b carries WritableBrand).
    b.value = { x: 1, y: 2 };
    expect(b.value).toEqual({ x: 1, y: 2 });

    // Chain through a regular read-only-param method, stays writable.
    const c = b.right(5);
    expect(c.value).toEqual({ x: 6, y: 2 });
    c.value = { x: 100, y: 50 };
    expect(c.value).toEqual({ x: 100, y: 50 });
  });

  it("Vec.derive collapses to read-only — both at type level AND at runtime", () => {
    const a = vec(0, 0);
    const n = num(0);
    const b = vecRightW(a, n);
    const d = Vec.derive([b], ([bv]) => ({ x: bv.x * 2, y: bv.y * 2 }));
    expect(d.value).toEqual({ x: 0, y: 0 });
    // Type-level: rejected. Runtime: throws.
    expect(() => {
      // @ts-expect-error — d is read-only at the type level.
      d.value = { x: 1, y: 1 };
    }).toThrow("Cannot write to a Computed");
  });
});

describe("batched multi-source write semantics", () => {
  it("two simultaneous writes to a writable param converge", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    batch(() => {
      n.value = 100;
      b.value = { x: 50, y: 30 };
    });
    // b.value = { x: 50, y: 30 } writes: a.y := 30, n := 50 - a.x = 40.
    // n.value = 100 writes n := 100.
    // The order matters. In batch, the LATER write wins for n.
    // Per the engine semantics, writes are flushed at batch end —
    // but the writes happen IN ORDER during the batch body.
    // So: n := 100 first, then b.value = ... overrides to n := 40, a.y := 30.
    expect(n.peek()).toBe(40);
    expect(a.peek()).toEqual({ x: 10, y: 30 });
    expect(b.value).toEqual({ x: 50, y: 30 });
  });
});
