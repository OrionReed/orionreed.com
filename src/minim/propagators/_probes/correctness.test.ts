// correctness.test.ts — mechanical correctness of lens × propagator composition.
//
// The "does it work" probes. Five questions:
//   1. Lens chain as a propagator's read input — subscription transitive?
//   2. Propagator step writes through a lens — does it route correctly?
//   3. Glitch-free updates when a single change cascades through both?
//   4. Cycles through both — termination story?
//   5. Freshness propagation through lens chains in-fixpoint — does
//      it work, or is there a gap?
//
// These aren't just tests — they're the foundation for the
// semantic-composition probes that follow.

import { describe, expect, it } from "vitest";
import { centroidLens, effect, num, vec } from "../../signals";
import { add, eq, propagator, propagators } from "..";

describe("1. lens chain as propagator read", () => {
  it("subscribes transitively through to chain parents", () => {
    const a = num(2);
    const b = num(3);
    const sum = a.add(b); // lens
    const result = num(0);

    const p = propagators();
    p.add(propagator([sum], [result], () => { result.value = sum.value * 10; }));

    expect(result.value).toBe(50);
    a.value = 5;
    expect(result.value).toBe(80);
    b.value = 7;
    expect(result.value).toBe(120);
    p.dispose();
  });

  it("Vec lens chain — propagator reads centroidLens, writes derived label", () => {
    const verts = [vec(0, 0), vec(10, 0), vec(5, 10)];
    const cent = centroidLens(verts);
    const label = num(0);

    const p = propagators();
    p.add(propagator([cent], [label], () => {
      const c = cent.value;
      label.value = Math.hypot(c.x, c.y);
    }));

    expect(label.value).toBeCloseTo(Math.hypot(5, 10 / 3));
    verts[0]!.value = { x: 30, y: 30 };
    expect(label.value).toBeCloseTo(Math.hypot(15, 40 / 3));
    p.dispose();
  });
});

describe("2. propagator step writes through a lens", () => {
  it("writing centroidLens redistributes to all parents", () => {
    const verts = [vec(0, 0), vec(10, 0), vec(5, 10)];
    const cent = centroidLens(verts);
    const target = vec(100, 100);

    const p = propagators();
    p.add(propagator([target], [cent], () => { cent.value = target.value; }));

    // Initial centroid (5, 10/3); delta to (100,100) shifts each vert.
    expect(verts[0]!.value.x).toBeCloseTo(95);
    expect(verts[1]!.value.x).toBeCloseTo(105);
    expect(verts[2]!.value.x).toBeCloseTo(100);
    p.dispose();
  });

  it("downstream effect sees coherent state — atomic batch", () => {
    const verts = [vec(0, 0), vec(10, 0), vec(5, 10)];
    const cent = centroidLens(verts);

    let observations = 0;
    let snapshot: ReadonlyArray<{ x: number; y: number }> = [];
    effect(() => {
      observations++;
      snapshot = verts.map(v => ({ x: v.value.x, y: v.value.y }));
    });

    const target = vec(0, 0);
    const p = propagators();
    p.add(propagator([target], [cent], () => { cent.value = target.value; }));
    target.value = { x: 50, y: 50 };

    // Coherence: in the latest snapshot, sum_x / 3 = cent.x (post-fire).
    const sumX = snapshot.reduce((s, v) => s + v.x, 0);
    expect(sumX / 3).toBeCloseTo(50);
    p.dispose();
  });
});

describe("3. mixed bidirectional graph behaviour", () => {
  it("lens → propagator → lens pipeline updates coherently", () => {
    const a = num(1);
    const b = num(2);
    const halfSum = a.add(b).scale(0.5); // lens chain
    const tracker = num(0);
    const tripled = tracker.scale(3); // lens

    const p = propagators();
    p.add(propagator([halfSum], [tracker], () => { tracker.value = halfSum.value; }));

    expect(tracker.value).toBe(1.5);
    expect(tripled.value).toBe(4.5);

    a.value = 10;
    expect(tracker.value).toBe(6);
    expect(tripled.value).toBe(18);
    p.dispose();
  });

  it("propagator-managed cell as an input to a downstream lens", () => {
    const x = num(0);
    const y = num(0);
    const sum = num(0);
    const big = sum.scale(10); // lens consumes propagator output

    const p = propagators();
    p.add(add(x, y, sum));

    x.value = 4;
    y.value = 6;
    expect(sum.value).toBe(10);
    expect(big.value).toBe(100);
    p.dispose();
  });
});

describe("4. cycles through lens AND propagator", () => {
  it("self-consistent cycle: lens-mediated feedback converges", () => {
    // a → lens scale 2 → twoA
    // twoA, b → propagator add → c
    // External writes only — no in-fixpoint feedback.
    const a = num(1);
    const twoA = a.scale(2);
    const b = num(3);
    const c = num(0);

    const p = propagators();
    p.add(add(twoA as never, b, c));
    expect(c.value).toBe(5); // 2*1 + 3
    a.value = 5;
    expect(c.value).toBe(13); // 2*5 + 3
    p.dispose();
  });

  it("self-inconsistent cycle: AUTO-EXPAND drives system to consistent fixpoint by adjusting b", () => {
    // a → halfA → add → c → twoC → eq → a.
    // Algebraically: a = 2c = 2(a/2 + b) = a + 2b ⇒ b must be 0.
    //
    // Before AUTO-EXPAND: eq never fired (freshness didn't see
    // through twoC), so a stayed 0 while c became 1 → constraint
    // a = 2c silently violated.
    //
    // After AUTO-EXPAND: eq fires (twoC's expanded reads include
    // c). The cycle DOES propagate. The bidirectional add has a
    // b-deriving propagator which OVERWRITES the user's input to
    // satisfy the constraints — the system converges to the only
    // algebraic fixpoint (b=0) by silently rewriting b.
    //
    // The constraint IS now satisfied (the silent inconsistency is
    // gone); but the user's input was overwritten. This is the
    // bidirectional-add write-policy showing through.
    const a = num(0);
    const halfA = a.scale(0.5);
    const b = num(0);
    const c = num(0);
    const twoC = c.scale(2);

    const p = propagators({ iterations: 100 });
    p.add(add(halfA as never, b, c));
    p.add(eq(twoC as never, a));

    b.value = 1;
    // Constraints are satisfied:
    expect(a.value).toBeCloseTo(2 * c.value);  // a = 2c ✓
    expect(c.value).toBeCloseTo(halfA.value + b.value);  // c = a/2 + b ✓
    // But b was overwritten:
    expect(b.value).toBe(0);  // user wrote 1; system wrote it back to 0.
    p.dispose();
  });
});

describe("5. freshness propagation through lens chains (post AUTO-EXPAND)", () => {
  it("EXTERNAL write to chain parent fires reader propagator", () => {
    const a = num(0);
    const doubled = a.scale(2);
    const out = num(0);

    const p = propagators();
    p.add(propagator([doubled], [out], () => { out.value = doubled.value; }));

    a.value = 5;
    expect(out.value).toBe(10);
    p.dispose();
  });

  it("IN-FIXPOINT write to chain parent NOW FIRES reader (gap closed)", () => {
    // Writer writes a (parent of `doubled` lens). Reader reads
    // `doubled`. Within the SAME body run, AUTO-EXPAND has
    // included `a` in reader's effective read set, so the cascade
    // works. Pre-AUTO-EXPAND this was the silent freshness gap.
    const trigger = num(0);
    const a = num(0);
    const doubled = a.scale(2);
    const out = num(0);

    const p = propagators();
    p.add(propagator([trigger], [a], () => { a.value = trigger.value; }));
    p.add(propagator([doubled], [out], () => { out.value = doubled.value; }));

    trigger.value = 5;
    expect(a.value).toBe(5);
    expect(doubled.value).toBe(10);
    expect(out.value).toBe(10); // ✓ AUTO-EXPAND fixes the cascade
    p.dispose();
  });

  it("multi-level lens chain — AUTO-EXPAND walks the full graph", () => {
    const trigger = num(0);
    const a = num(0);
    const b = num(3);
    const big = a.add(b).scale(2); // chain with two parents
    const out = num(0);

    const p = propagators();
    p.add(propagator([trigger], [a], () => { a.value = trigger.value; }));
    p.add(propagator([big], [out], () => { out.value = big.value; }));

    trigger.value = 4;
    // big = (4 + 3) * 2 = 14. AUTO-EXPAND included a in reader's
    // effective reads.
    expect(out.value).toBe(14);

    // Mutating b also fires the reader (b is also transitive).
    b.value = 5;
    expect(out.value).toBe(18);
    p.dispose();
  });
});
