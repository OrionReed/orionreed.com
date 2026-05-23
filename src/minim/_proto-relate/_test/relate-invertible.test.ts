// relate-invertible.test.ts — first-class invertible relations.
//
// A relation can declare a `fastPath`: a closed-form solver that
// runs BEFORE Newton. When the relation has enough information to
// satisfy itself (typically: one side of a bidirectional lens is
// pinned, the other is free), the fast path returns the cell
// updates to apply, and the runtime marks those cells pinned so
// Newton skips them.
//
// This unifies two previously-separate constructs: `Signal#through`
// (engine-level invertible lens) and `relate()` (userland general
// relation). A `lensNum(a, b, fwd, bwd)` is a relation that
// participates in clusters AND solves itself in zero Newton
// iterations whenever closed-form solution is possible.
//
// The peeling pass iterates: deriving one cell can unlock the next
// relation's fast path. So a chain `c = 2b, b = 3a` cascades —
// pin a, b derives via lens 1, c derives via lens 2, both with
// no Newton. A purely-invertible cluster reports `iters: 0` in
// its `clusterHealth`.

import { describe, expect, it } from "vitest";
import { eq, lensNum, lensVec, softNum } from "../constraints";
import { num, vec } from "../index";
import { clusterHealth, hardPin, relate } from "../relate";

describe("Invertible relations — Newton-free fast path", () => {
  it("simple Num lens: pin source, derive output via fwd", () => {
    // Initial values placed on the lens curve so construction-time
    // solve is a no-op. (When neither side is pinned, the fast path
    // doesn't fire; LSQ has infinitely many solutions and Newton
    // picks one.)
    const a = num(1);
    const b = num(2);
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );

    a.value = 5;
    expect(b.value).toBeCloseTo(10);
    const h = clusterHealth(a)!.peek();
    expect(h.iters).toBe(0); // Closed-form, no Newton needed.
  });

  it("simple Num lens: pin output, derive input via bwd", () => {
    const a = num(1);
    const b = num(2);
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );
    b.value = 10;
    expect(a.value).toBeCloseTo(5);
    expect(clusterHealth(b)!.peek().iters).toBe(0);
  });

  it("chain of three lenses cascades in one peeling pass", () => {
    // Place initial values on the chain so construction-time is a no-op.
    const a = num(1);
    const b = num(2); //  b = 2a
    const c = num(7); //  c = b + 5
    const d = num(-7); // d = -c
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );
    lensNum(
      b,
      c,
      x => x + 5,
      y => y - 5,
    );
    lensNum(
      c,
      d,
      x => -x,
      y => -y,
    );

    a.value = 3;
    expect(b.value).toBeCloseTo(6);
    expect(c.value).toBeCloseTo(11);
    expect(d.value).toBeCloseTo(-11);
    expect(clusterHealth(a)!.peek().iters).toBe(0);
  });

  it("chain reverses: pin tail, propagate backwards via bwd", () => {
    const a = num(1);
    const b = num(2);
    const c = num(7);
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );
    lensNum(
      b,
      c,
      x => x + 5,
      y => y - 5,
    );
    c.value = 11;
    // c = 11 → b = 6 → a = 3
    expect(b.value).toBeCloseTo(6);
    expect(a.value).toBeCloseTo(3);
    expect(clusterHealth(c)!.peek().iters).toBe(0);
  });

  it("Vec lens: rotate by 90° and back", () => {
    // Place A=(1,0), B=(0,1) so initial state satisfies the lens.
    const A = vec(1, 0);
    const B = vec(0, 1);
    lensVec(
      A,
      B,
      v => ({ x: -v.y, y: v.x }),
      v => ({ x: v.y, y: -v.x }),
    );
    A.value = { x: 2, y: 3 };
    expect(B.value.x).toBeCloseTo(-3);
    expect(B.value.y).toBeCloseTo(2);
    expect(clusterHealth(A)!.peek().iters).toBe(0);

    B.value = { x: 5, y: 7 };
    expect(A.value.x).toBeCloseTo(7);
    expect(A.value.y).toBeCloseTo(-5);
  });

  it("mixed cluster: lens + general nonlinear constraint", () => {
    // a, b linked by lens (b = 2a). Plus pythagoras a² + b² = c².
    // Pinning a derives b for free; Newton then solves c.
    const a = num(2);
    const b = num(4); // on lens curve
    const c = num(Math.sqrt(20)); // satisfies pythagoras
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );
    relate({
      cells: [a, b, c],
      residual: ([va, vb, vc], out) => {
        const A = va as number;
        const B = vb as number;
        const C = vc as number;
        out[0] = A * A + B * B - C * C;
      },
      m: 1,
    });

    a.value = 3;
    // b derived in lens-peel: b = 6.
    expect(b.value).toBeCloseTo(6);
    // c solved by Newton from sqrt(20)≈4.47 to sqrt(45)≈6.7.
    expect(c.value ** 2).toBeCloseTo(45, 3);
    const h = clusterHealth(a)!.peek();
    expect(h.iters).toBeGreaterThan(0);
    // Pythagoras residual `a²+b²-c²` is mildly nonlinear in c near
    // the root; with damped LM, this typically converges in ≤16
    // iters from a warm start of similar magnitude.
    expect(h.iters).toBeLessThanOrEqual(16);
  });

  it("lensed cell can be hard-pinned; lens derives the other side", () => {
    // hardPin on the source forces re-derivation each solve.
    const a = num(0);
    const b = num(0);
    lensNum(
      a,
      b,
      x => x * x,
      y => Math.sqrt(y),
    );
    hardPin(a, () => 4);
    // Trigger a solve via a no-op write to b.
    b.value = 999;
    expect(a.value).toBe(4); // hard-pinned
    expect(b.value).toBeCloseTo(16); // derived
    expect(clusterHealth(a)!.peek().iters).toBe(0);
  });

  it("lens identity (fwd = id, bwd = id) acts as eq with closed-form", () => {
    const a = num(1);
    const b = num(2);
    lensNum(
      a,
      b,
      x => x,
      y => y,
    );
    a.value = 5;
    expect(b.value).toBeCloseTo(5);
    expect(clusterHealth(a)!.peek().iters).toBe(0);
  });

  it("eq() now also fast-paths on pinned-side", () => {
    // Sanity: the existing `eq()` got upgraded with a fastPath too.
    // Pure-eq clusters should solve in 0 iters.
    const a = num(1);
    const b = num(2);
    const c = num(3);
    eq(a, b);
    eq(b, c);
    a.value = 7;
    expect(b.value).toBeCloseTo(7);
    expect(c.value).toBeCloseTo(7);
    expect(clusterHealth(a)!.peek().iters).toBe(0);
  });

  it("under-determined: free cells in middle of chain still work", () => {
    // Two lenses in a chain. Pin head, both downstream cells derive.
    const a = num(2);
    const b = num(4);
    const c = num(5);
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );
    lensNum(
      b,
      c,
      x => x + 1,
      y => y - 1,
    );
    a.value = 3;
    expect(b.value).toBeCloseTo(6);
    expect(c.value).toBeCloseTo(7);
    expect(clusterHealth(a)!.peek().iters).toBe(0);
  });

  it("composes: lens fixes b, Newton solves remaining DOF", () => {
    // a — lens → b. Plus pythagoras a² + b² = c². With a hard-
    // pinned, b derives by lens (no Newton). Newton then sees
    // a fixed and b fixed, only c free; converges in 1-2 iters.
    const a = num(3);
    const b = num(6); // on lens curve
    const c = num(Math.hypot(3, 6));
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );
    relate({
      cells: [a, b, c],
      residual: ([va, vb, vc], out) => {
        out[0] = (va as number) ** 2 + (vb as number) ** 2 - (vc as number) ** 2;
      },
      m: 1,
    });
    hardPin(a, () => 4);
    // Trigger a solve. b derives via lens to 8; c² = 16 + 64 = 80.
    // Use a no-op-ish write to c just to drive the solve.
    c.value = c.value;
    expect(b.value).toBeCloseTo(8, 4);
    expect(c.value ** 2).toBeCloseTo(80, 2);
    const h = clusterHealth(a)!.peek();
    expect(h.iters).toBeGreaterThanOrEqual(0);
    expect(h.iters).toBeLessThanOrEqual(8);
  });
});

describe("Composition with strong soft pulls — fast path doesn't degrade", () => {
  it("lens always wins over a soft pull on the derived side", () => {
    // lensNum says b = 2a. softNum says b → 100. With lens fast-
    // path applied (a is pinned), b is set to 2a regardless of
    // soft pull. Soft pull becomes pure residual reporting.
    const a = num(3);
    const b = num(0);
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );
    softNum(b, 100, 1e6);
    a.value = 4;
    expect(b.value).toBeCloseTo(8); // lens wins; soft pull ignored
  });
});
