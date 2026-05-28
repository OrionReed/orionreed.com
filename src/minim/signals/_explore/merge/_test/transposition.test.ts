// transposition.test.ts — §10 step 1: "test the transposition in
// isolation". The question this file is trying to answer empirically:
//
//   Can the engine's existing topology (Link chain, flags, batchDepth)
//   carry enough information for a backward write to identify, on
//   arrival at a merge point, which forward sub it originated from?
//
// The §6 sketch claims yes — that the same Link records store
// `dep`/`sub` + `nextDep`/`nextSub`, so transposed traversal is
// scaffolded. These tests do not yet build a transposed `checkDirty`;
// they just probe what IS observable during a real cascade, so we
// know what's actually there before designing the dual walk.
//
// Findings recorded by these tests are not assertions about what
// SHOULD be true; they are assertions about what IS true today, so
// regressions in the engine's bwd machinery would surface here.

import { describe, expect, it } from "vitest";
import { _batchDepth, Num, num, Signal } from "../index";

/** Walk the forward `subs` chain of `dep` and return the array of
 *  subscribing nodes in insertion order. This is the data structure
 *  a transposed `checkDirty`-style walk would need to enumerate
 *  "who could write back to me". */
function subsOf(dep: Signal<unknown>): unknown[] {
  const out: unknown[] = [];
  let l = dep.subs;
  while (l !== undefined) {
    out.push(l.sub);
    l = l.nextSub;
  }
  return out;
}

describe("transposition probe: structural availability of subs chain", () => {
  it("a pure-lens chain that has never been READ leaves root.subs empty", () => {
    // The Link graph is observation-driven. Lens construction installs
    // closures but does not subscribe — only a `value` read inside an
    // active reactive context (computed/effect) calls `link(dep,
    // activeSub, cycle)`.
    //
    // Implication for the merge design: if the merge wants to
    // enumerate "all bwd-reachable origins" by walking `subs`, it
    // can only do so for chains that are forward-observed. Pure
    // bwd-only chains (write-without-read) won't appear in the
    // structural graph. The merge's input-slot bookkeeping cannot
    // rely on `subs` alone.
    const root = num(1);
    root.add(1);
    root.scale(2);
    expect(subsOf(root)).toEqual([]);
  });

  it("a top-level lens read installs the lens itself as a sub on root", () => {
    // Reading `a.value` at top level enters a's `_update` (activeSub
    // = a), which reads parent.value, which links `a` as a sub of
    // root. So lens reads have the side effect of populating subs.
    const root = num(1);
    const a = root.add(1);
    const b = root.scale(2);
    void a.value;
    void b.value;
    const subs = subsOf(root);
    expect(subs.length).toBe(2);
    expect(subs).toContain(a);
    expect(subs).toContain(b);
  });

  it("FUSION FINDING: a derived computed bypasses its intermediate lens and links directly to root", () => {
    // `Num.derive(a, v => v)` where `a = root.add(1)` goes through
    // `Signal._fuse`. Fusion recognises `a` as already fused on
    // root and re-roots the new derived cell directly at root —
    // composedFwd chains the two functions, so reading the derived
    // cell calls `root.value` (NOT `a.value`). Therefore `a` is
    // never read, never installs a sub on root, and `subA` links
    // straight to root.
    //
    // Consequence for the merge design: fusion eliminates the
    // intermediate-lens nodes from the Link graph entirely. Any
    // merge scheme that wants per-intermediate-lens slots cannot
    // recover them from `subs` chains — they've been optimised
    // away. The merge primitive must operate at the *un-fused*
    // structural level (which is just the root + the leaf readers),
    // or it must designate fusion barriers (§6 step 1: "fusion must
    // not re-root through it").
    const root = num(1);
    const a = root.add(1);
    const subA = Num.derive(a, v => v);
    void subA.value;
    expect(subsOf(root)).toEqual([subA]); // not `a` — fusion ate it
    expect(subsOf(a)).toEqual([]); // `a` is a fused passthrough; nobody linked to it
  });
});

describe("transposition probe: what's visible during a backward cascade", () => {
  /** Capture a trace of (callee, arg, batchDepth) tuples on every
   *  `_setWithExclusion` invocation reaching `root`. The point: see
   *  what state the engine exposes at the moment a contribution
   *  arrives — is it enough to identify the originating path? */
  function tracedRoot() {
    const root = num(0);
    const trace: {
      value: number;
      engineBatchDepth: number;
      flagsAtEntry: number;
      excluding: unknown;
    }[] = [];
    const orig = root._setWithExclusion.bind(root);
    root._setWithExclusion = function (next, excluding) {
      trace.push({
        value: next as number,
        engineBatchDepth: _batchDepth(),
        flagsAtEntry: this.flags,
        excluding,
      });
      orig(next, excluding);
    };
    return { root, trace };
  }

  it("origin path is NOT carried by the engine — the write arrives anonymously", () => {
    const { root, trace } = tracedRoot();
    const a = root.add(1);
    const b = root.scale(2);
    const sum = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    sum.value = 6;
    // tracedRoot() initialises root to 0, so a=1 and b=0 initially;
    // total=1; distribute([6*1/1, 6*0/1]) = [6, 0]; root via
    // a.bwd(6) = 5; root via b.bwd(0) = 0.
    expect(trace.length).toBe(2);
    // Both writes arrive as (value, batchDepth, flags, excluding).
    // `excluding` is `activeNetwork` (undefined here, since we're
    // not inside a `network(...)`). It does NOT identify the
    // originating lens.
    expect(trace[0]!.excluding).toBeUndefined();
    expect(trace[1]!.excluding).toBeUndefined();
    expect(trace[0]!.value).toBeCloseTo(5);
    expect(trace[1]!.value).toBeCloseTo(0);
    // CRITICAL FINDING for the merge design: to attribute a
    // contribution to its origin slot, the lens setter would need to
    // pass its own identity through `_setWithExclusion`. Today it
    // doesn't. So per-slot merge state requires either:
    //   (a) augmenting `_setWithExclusion`'s signature with an
    //       origin tag,
    //   (b) inferring origin from a side channel (fragile), or
    //   (c) recording origin in the setter closure itself — each
    //       lens captures its position in the merge's input slots
    //       at construction time.
    // Option (c) is the cheapest to prototype: origin is static
    // structure, not runtime context.
  });

  it("during the cascade, the engine's batchDepth is >0 (in-flight discriminator works)", () => {
    const { root, trace } = tracedRoot();
    const a = root.add(1);
    const b = root.scale(2);
    const sum = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    sum.value = 6;
    for (const t of trace) {
      expect(t.engineBatchDepth).toBeGreaterThanOrEqual(1);
    }
  });

  it("two sequential top-level writes produce two separate cascades; depth resets between", () => {
    const { root, trace } = tracedRoot();
    const a = root.add(1);
    const b = root.scale(2);
    const sum1 = Num.lens(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const tot = av + bv || 1;
        return [(t * av) / tot, (t * bv) / tot];
      },
    );
    sum1.value = 6;
    sum1.value = 12;
    expect(trace.length).toBe(4);
    expect(trace.every(t => t.engineBatchDepth === 1)).toBe(true);
    // No way from inside the intercept to tell "the first write of
    // a new propagation" apart from "the second write of an ongoing
    // one" using `engineBatchDepth` ALONE — both report 1. The
    // discriminator must observe the TRANSITION from 0 to 1 from
    // the outside, which we can do by polling depth at the prior
    // microtask, or by hooking batch entry. The merge prototype
    // currently checks depth AT INTERCEPT and resets the accumulator
    // when depth === 0 — which is only true OUTSIDE a fan-in
    // cascade, i.e., for direct user-driven writes. For fan-in
    // cascades, the reset must happen elsewhere (e.g., on flush
    // exit). Open question for the next iteration.
  });
});
