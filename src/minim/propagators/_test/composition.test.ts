// composition.test.ts — non-coloring property: existing signals
// (any class, any lens chain) work as propagator participants
// without modification.

import { describe, expect, it } from "vitest";
import { effect, num, Num, signal, Vec, vec } from "../../signals";
import { adder, eq, propagators } from "..";

describe("composition: non-coloring", () => {
  it("plain Num signals participate in propagators", () => {
    const a = num(2);
    const b = num(3);
    const c = num(0);
    const p = propagators();
    p.add(adder(a, b, c));
    expect(c.value).toBe(5);
    p.dispose();
  });

  it("a lens-derived Num participates as a propagator output", () => {
    // The classic case: `a` is a real signal; `aPlus5` is a lens
    // that derives a + 5 with a writable bwd. Use BOTH in a propagator
    // network: adder(aPlus5, b, c) means "(a+5) + b = c".
    // Should work — the lens IS a Writable<Num>, propagator just sees
    // it as a Num.
    const a = num(10);
    const aPlus5 = a.add(5); // Writable<Num> — lens
    const b = num(2);
    const c = num(0);

    const p = propagators();
    p.add(adder(aPlus5, b, c));
    // a=10 → aPlus5=15; aPlus5 + b = c → c = 17.
    expect(aPlus5.value).toBe(15);
    expect(c.value).toBe(17);

    // Drag the underlying root: a=20 → aPlus5=25 → c=27.
    a.value = 20;
    expect(aPlus5.value).toBe(25);
    expect(c.value).toBe(27);

    // Drag the lens directly: aPlus5=100 → bwd writes a=95.
    // Then c = 100 + 2 = 102.
    aPlus5.value = 100;
    expect(a.value).toBe(95);
    expect(c.value).toBe(102);

    p.dispose();
  });

  it("a lens-derived Num back-deduces through the propagator network", () => {
    // adder(a, b, c). Wrap a in a lens. Drag c; expect a (and via lens
    // the underlying root) to back-deduce.
    const aRoot = num(0);
    const a = aRoot.add(0); // identity-like lens, but a real lens
    const b = num(3);
    const c = num(0);

    const p = propagators();
    p.add(adder(a, b, c));

    c.value = 50;
    // freshness: c fresh → propagator (a, c → b): b = 50 - 0 = 50.
    //            propagator (b, c → a): a = 50 - 3 = 47. a's lens
    //              writes back to aRoot = 47.
    // After convergence: aRoot = 47, a = 47, b = 47 (b matched first
    // due to propagator order), c = 50 (a + b = 47 + 47 = 94?? hmm).
    // Wait — let me think. The freshness algorithm runs ALL
    // propagators whose reads contain fresh signals, in a single iter.
    // First iter: fresh = {c}. Propagators that read c: 2 of the 3
    // adder-directions. Both run: writes new b and new a.
    // After iter 1: a=47, b=50. Both newly fresh.
    // Iter 2: fresh = {a, b}. The remaining propagator (a, b → c) reads
    // both. Runs: c = a + b = 47 + 50 = 97. NEW c. c is fresh now.
    // Iter 3: c fresh → re-run a-direction and b-direction. Both
    // recompute against new c=97: b = 97 - 47 = 50 (same, no change),
    // a = 97 - 50 = 47 (same, no change). No fresh.
    // Done. Final: a=47, b=50, c=97. NOT what user wrote (c=50).
    //
    // This is the user-write-overwritten pathology I called out:
    // when ALL three cells are involved in a cycle, declaring c=50
    // can't override the network. To "lock" c at 50, user would need
    // to add a constant(c, 50) propagator, removing one direction.
    //
    // What we CAN assert is convergence + consistency: a + b = c.
    expect(a.value + b.value).toBe(c.value);
    // The lens correctly propagated whatever a converged to → aRoot.
    expect(aRoot.value).toBe(a.value);
    p.dispose();
  });

  it("a Vec signal's `.x` lens participates in a propagator", () => {
    // Demonstrates: a Vec's field-lens is just a Writable<Num>. The
    // propagator doesn't know it's a Vec field; it sees a Num.
    // Writes to vec.x via the propagator update vec.value's x.
    //
    // Important note about `eq` on initial fire: since eq is symmetric,
    // declaration order picks which side's value wins on the first
    // run. Here `eq(v.x, target)` runs `v.x → target` first, so on
    // initial fire target gets v.x's value (0). To start with target's
    // value mirroring into v.x, write target AFTER the network exists.
    const v = vec(0, 0);
    const target = num(0);

    const p = propagators();
    p.add(eq(v.x, target));

    target.value = 50;
    expect(v.value.x).toBe(50);

    target.value = 100;
    expect(v.value.x).toBe(100);
    expect(v.value.y).toBe(0); // y is untouched

    // Writing the vec directly: v.value = {x: 7, y: 9} updates v.x;
    // propagator notices, writes target = 7.
    v.value = { x: 7, y: 9 };
    expect(target.value).toBe(7);
    expect(v.value.y).toBe(9);
    p.dispose();
  });

  it("downstream effect sees propagator's writes through normal subscription", () => {
    const a = num(1);
    const b = num(2);
    const c = num(0);
    const observed: number[] = [];
    const stop = effect(() => {
      observed.push(c.value);
    });
    expect(observed).toEqual([0]);

    const p = propagators();
    p.add(adder(a, b, c));
    // Initial run: c = 3. Effect sees the write, fires.
    expect(observed[observed.length - 1]).toBe(3);

    a.value = 10;
    // Network re-fires; c = 12. Effect sees it.
    expect(observed[observed.length - 1]).toBe(12);

    p.dispose();
    stop();
  });

  it("propagator over signals from different value classes (Num + Vec)", () => {
    // distance-style: read a Vec, write a Num. Custom propagator.
    const v = vec(3, 4);
    const dist = num(0);

    const p = propagators();
    p.add({
      reads: [v],
      writes: [dist],
      step: () => {
        const { x, y } = v.value;
        dist.value = Math.hypot(x, y);
      },
    });
    expect(dist.value).toBe(5);

    v.value = { x: 5, y: 12 };
    expect(dist.value).toBe(13);

    p.dispose();
  });

  it("two propagator networks on overlapping signals coexist", () => {
    // p1: a + b = c. p2: c * 2 = d. Independent networks observing the
    // same signal `c`. A change to a triggers p1 (which writes c);
    // p1's auto-batch flushes the queue; that flush wakes p2 (because
    // p2 subscribed to c via its own `network()`).
    const a = num(1);
    const b = num(2);
    const c = num(0);
    const d = num(0);

    const p1 = propagators();
    const p2 = propagators();
    p1.add(adder(a, b, c));
    p2.add({
      reads: [c],
      writes: [d],
      step: () => {
        d.value = c.value * 2;
      },
    });
    // Initial: c = 3, d = 6.
    expect(c.value).toBe(3);
    expect(d.value).toBe(6);

    a.value = 7;
    expect(c.value).toBe(9);
    expect(d.value).toBe(18);

    p1.dispose();
    p2.dispose();
  });
});

describe("composition: typed cells without explicit Cell wrapper", () => {
  it("a Num signal IS a usable propagator cell — no Cell type needed", () => {
    // The whole point of non-coloring: I can take an existing Num
    // signal (e.g. one I'm already using elsewhere in my diagram)
    // and make it participate in a propagator network without
    // changing its type. No `cell(num(0), lattice)` ceremony.
    const x = num(5); // Writable<Num>
    const y = num(0);
    expect(x).toBeInstanceOf(Num);

    const p = propagators();
    p.add(eq(x, y));
    expect(y.value).toBe(5);
    expect(x).toBeInstanceOf(Num); // still a Num, no upgrade

    p.dispose();
  });

  it("Vec.lens-derived signal works as a propagator cell", () => {
    const root = vec(10, 20);
    // A custom Vec.lens: derive a vec offset by some constant.
    const offset = Vec.lens(
      root,
      v => ({ x: v.x + 1, y: v.y + 2 }),
      (newV, _v) => ({ x: newV.x - 1, y: newV.y - 2 }),
    );
    const targetX = num(0);

    const p = propagators();
    p.add(eq(offset.x, targetX));
    // root.x = 10 → offset.x = 11 → targetX = 11.
    expect(targetX.value).toBe(11);

    targetX.value = 100;
    // eq writes offset.x = 100, which back-propagates to root.x = 99.
    expect(root.value.x).toBe(99);
    expect(root.value.y).toBe(20); // y untouched

    p.dispose();
  });
});
