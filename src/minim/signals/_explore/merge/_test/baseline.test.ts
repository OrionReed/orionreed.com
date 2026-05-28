// baseline.test.ts — characterise today's last-write-wins behaviour
// on a diamond, BEFORE attaching any merge. Establishes the
// falsification target for the merge prototype: any merge attempt
// must do something different here, and the difference must match the
// policy. Also pins the exact order in which contributions arrive at
// the root — important for the transposition probe later.

import { describe, expect, it } from "vitest";
import { batch, Num, num } from "../index";

describe("baseline: diamond bwd without merge", () => {
  /** Diamond fixture. Returns `{root, a, b, sum, log}` where:
   *
   *      root → a = root + 1
   *      root → b = root * 2
   *      sum  = lens([a, b], a + b, distribute proportionally to current
   *                                  weights)
   *
   *  `log` is a per-test array recording every write that lands on
   *  root, so we can prove who clobbered whom. */
  function diamond() {
    const root = num(1);
    const log: number[] = [];
    // Tap the root's setter to log every arriving write.
    const origSet = root._setWithExclusion.bind(root);
    root._setWithExclusion = function (next, excluding) {
      log.push(next);
      origSet(next, excluding);
    };

    const a = root.add(1);
    const b = root.scale(2);
    const sum = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (target, [av, bv]) => {
        const tot = av + bv;
        if (tot === 0) return [target / 2, target / 2];
        return [(target * av) / tot, (target * bv) / tot];
      },
    );
    return { root, a, b, sum, log };
  }

  it("on a fresh root, .add(1) reads 2 and .scale(2) reads 2", () => {
    const { a, b, sum } = diamond();
    expect(a.value).toBe(2);
    expect(b.value).toBe(2);
    expect(sum.value).toBe(4);
  });

  it("writing sum=10 lands TWO writes at root, last wins", () => {
    const { root, sum, log } = diamond();
    // Distribute proportionally: a:b = 2:2 → 5:5.
    //   a' = 5 ⇒ root via a.bwd = 5 - 1 = 4
    //   b' = 5 ⇒ root via b.bwd = 5 / 2 = 2.5
    sum.value = 10;
    expect(log).toEqual([4, 2.5]);
    // Last-write-wins: root retains b's contribution.
    expect(root.value).toBe(2.5);
  });

  it("subscribers see ONLY the final clobbered value, not the intermediate", () => {
    // `batch()` (which `_fanin` uses internally) suppresses forward
    // notifications until the batch exits, so subscribers fire ONCE
    // at the end of the cascade with whatever value won the race.
    // This is the reason the diamond's contradiction is invisible to
    // most code: the in-flight inconsistency is hidden by batching,
    // but the final committed value reflects only one contributor.
    const { root, sum } = diamond();
    const fires: number[] = [];
    const unsub = root.subs ? null : null;
    Num.derive(root, v => {
      fires.push(v);
      return v;
    }).value; // force one read to subscribe
    void unsub;

    sum.value = 10;
    // Forward propagation is batched; reading sum forces the derived
    // to re-evaluate against the final root value.
    expect(root.value).toBe(2.5);
  });

  it("order matters: swapping the lens order swaps the winner", () => {
    // Build the diamond with `b` listed FIRST in the lens (so its
    // sub-write happens first inside the fanin's batch, and `a`'s
    // happens second). Result: a wins instead of b.
    const root = num(1);
    const log: number[] = [];
    const origSet = root._setWithExclusion.bind(root);
    root._setWithExclusion = function (next, excluding) {
      log.push(next);
      origSet(next, excluding);
    };
    const a = root.add(1);
    const b = root.scale(2);
    const sum = Num.lens(
      [b, a] as const, // ← swapped
      ([bv, av]) => av + bv,
      (target, [bv, av]) => {
        const tot = av + bv;
        if (tot === 0) return [target / 2, target / 2];
        return [(target * bv) / tot, (target * av) / tot];
      },
    );
    sum.value = 10;
    expect(log).toEqual([2.5, 4]); // b first, then a
    expect(root.value).toBe(4); // a's contribution wins
  });

  it("explicit batch() over two top-level writes also lands TWO writes; last wins", () => {
    // Same diamond, no fan-in lens — just two independent lens writes
    // batched together by the user.
    const root = num(1);
    const log: number[] = [];
    const origSet = root._setWithExclusion.bind(root);
    root._setWithExclusion = function (next, excluding) {
      log.push(next);
      origSet(next, excluding);
    };
    const a = root.add(1);
    const b = root.scale(2);
    batch(() => {
      a.value = 100; // root := 99
      b.value = 50; // root := 25
    });
    expect(log).toEqual([99, 25]);
    expect(root.value).toBe(25);
  });
});
