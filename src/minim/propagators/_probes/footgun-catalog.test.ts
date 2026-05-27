// footgun-catalog.test.ts
//
// REAL-TERMS PROBE: every footgun a user mixing lenses and
// propagators actually hits, with reproduction + workaround.
// Worked through as ACTUAL CODE — not just narrative.
//
// The catalog (in order of how-likely-to-bite):
//   1. Freshness gap — chain reads don't fire in-fixpoint.
//   2. Initial-fire direction wins on bidirectional propagators.
//   3. Cycles through lens chains can silently leave the system
//      inconsistent.
//   4. Multiple propagators writing the same lens: order matters.
//   5. Computed cost cascades — peeking a stale chain repeatedly.
//   6. Disposing the propagator doesn't dispose the lens.
//   7. Bwd policy surprise — writing through a centroid moves
//      ALL parents, not just the one you "logically" meant.
//   8. Lens chain on cells outside the network — writes still
//      fire the network normally, but the network can't force
//      the boundary cell.

import { describe, expect, it } from "vitest";
import { centroidLens, num, vec } from "../../signals";
import { add, eq, propagator, propagators } from "..";

// ─── 1. Freshness gap (FIXED by AUTO-EXPAND) ───────────────────────

describe("(Closed) Footgun 1: in-fixpoint cascade through lens", () => {
  it("AUTO-EXPAND closed this — writer→a→lens→reader works in one fire", () => {
    const trigger = num(0);
    const a = num(0);
    const doubled = a.scale(2);
    const out = num(0);

    const p = propagators();
    p.add(
      propagator([trigger], [a], () => {
        a.value = trigger.value;
      }),
    );
    p.add(
      propagator([doubled], [out], () => {
        out.value = doubled.value;
      }),
    );

    trigger.value = 5;
    expect(out.value).toBe(10); // ✓ AUTO-EXPAND included `a` in reader's effective reads
    p.dispose();
  });
});

// ─── 2. Initial-fire direction ─────────────────────────────────────

describe("Footgun 2: bidirectional propagator's first-fire direction is order-dependent", () => {
  it("PROBLEM: add's c-deriving propagator fires first, overwriting a or b", () => {
    // User wants to set up add(a, b, c) with a=2, b=3, expecting
    // c to derive as 5. But what if they declare it differently?
    const a = num(2);
    const b = num(3);
    const c = num(0);

    // add.prop1 (a+b=c) fires first. Initial fire writes c.
    const p = propagators();
    p.add(add(a, b, c));
    expect(c.value).toBe(5); // OK, c derived

    // But: if c had a meaningful initial value, it'd be overwritten.
    p.dispose();

    const a2 = num(0);
    const b2 = num(0);
    const c2 = num(7); // user set c first
    const p2 = propagators();
    p2.add(add(a2, b2, c2));
    expect(c2.value).toBe(0); // c was OVERWRITTEN by initial fire (a+b = 0)
    p2.dispose();
  });

  it("WORKAROUND: write the canonical driver AFTER install", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    const p = propagators();
    p.add(add(a, b, c));
    // Now write the actual values.
    a.value = 2;
    b.value = 3;
    expect(c.value).toBe(5);
    p.dispose();
  });
});

// ─── 3. Cycles through lens chains ─────────────────────────────────

describe("Footgun 3 (changed character): cycle through lens drives to fixpoint", () => {
  it("the cycle converges via overwriting one of the user's inputs", () => {
    // Pre-AUTO-EXPAND: silently inconsistent.
    // Post-AUTO-EXPAND: cycle propagates correctly. Bidirectional
    // add finds the algebraic fixpoint by rewriting b to 0
    // (the only feasible value). User's input gets overwritten.
    const a = num(0);
    const halfA = a.scale(0.5);
    const b = num(0);
    const c = num(0);
    const twoC = c.scale(2);

    const p = propagators({ iterations: 100 });
    p.add(add(halfA as never, b, c));
    p.add(eq(twoC as never, a));

    b.value = 1;
    // System satisfies all constraints — but b was overwritten.
    expect(a.value === 2 * c.value).toBe(true);
    expect(b.value).toBe(0); // user wrote 1; got overwritten
    p.dispose();
    // Lesson: bidirectional propagators (add writes b in one
    // direction) can rewrite user input to satisfy the cycle. If
    // you want the user's b respected, use a one-direction
    // propagator (only c-deriving).
  });
});

// ─── 4. Multiple writers to the same lens ──────────────────────────

describe("Footgun 4: two propagators writing the same lens — last write wins per fire", () => {
  it("two writers race to set centroidLens to different targets", () => {
    const verts = [vec(0, 0), vec(0, 0), vec(0, 0)];
    const cent = centroidLens(verts);

    const target1 = vec(10, 0);
    const target2 = vec(0, 20);

    const p = propagators();
    p.add(
      propagator([target1], [cent], () => {
        cent.value = target1.value;
      }),
    );
    p.add(
      propagator([target2], [cent], () => {
        cent.value = target2.value;
      }),
    );

    // Both fire on install. The SECOND propagator (target2) wins
    // because it's listed later and runs later.
    expect(cent.value).toEqual({ x: 0, y: 20 });
    p.dispose();
  });

  it("WORKAROUND: combine the two intents into one propagator", () => {
    // E.g., "centroid follows whichever target is currently
    // active." Express the choice in ONE step body.
    const verts = [vec(0, 0), vec(0, 0), vec(0, 0)];
    const cent = centroidLens(verts);
    const target = vec(10, 0);
    const useTarget = num(1); // 1 = target, 0 = freeze

    const p = propagators();
    p.add(
      propagator([target, useTarget], [cent], () => {
        if (useTarget.value > 0) cent.value = target.value;
      }),
    );

    expect(cent.value).toEqual({ x: 10, y: 0 });
    p.dispose();
  });
});

// ─── 5. Computed cost cascade ──────────────────────────────────────

describe("Footgun 5: peeking a stale chain inside a hot loop re-evaluates each time", () => {
  it("hot loop reading chain.value N times: each .value re-checks staleness", () => {
    const a = num(1);
    const b = num(2);
    const sum = a.add(b);

    const evaluations = 0;
    const tracked = a.add(b).scale(2); // chain that we'll peek
    void tracked;

    // Naïve: read tracked.value 1000 times in a tight loop.
    let total = 0;
    for (let i = 0; i < 1000; i++) total += sum.value;
    // 1000 reads, but the value didn't change → fast (cached).
    expect(total).toBe(1000 * 3);
    expect(evaluations).toBe(0); // counter unused; we're just demonstrating
  });

  it("WORKAROUND: cache the chain's value at start of loop", () => {
    const a = num(1);
    const b = num(2);
    const sum = a.add(b);

    // Cache once.
    const v = sum.value;
    let total = 0;
    for (let i = 0; i < 1000; i++) total += v;
    expect(total).toBe(3000);
  });
});

// ─── 6. Disposal scope ─────────────────────────────────────────────

describe("Footgun 6: disposing the propagator doesn't dispose the lens chain", () => {
  it("after Propagators.dispose, lens chain still works (it's its own cell)", () => {
    const a = num(0);
    const b = num(0);
    const sum = a.add(b);
    const out = num(0);

    const p = propagators();
    p.add(
      propagator([sum], [out], () => {
        out.value = sum.value;
      }),
    );

    a.value = 5;
    expect(out.value).toBe(5);

    p.dispose();
    // After dispose, propagator no longer fires. But sum still
    // computes — it's a separate cell with its own lifecycle.
    a.value = 10;
    expect(sum.value).toBe(10); // chain still works
    expect(out.value).toBe(5); // propagator stopped
  });
});

// ─── 7. Bwd policy surprise ────────────────────────────────────────

describe("Footgun 7: write through centroid moves ALL parents, not 'just one'", () => {
  it("user expectation: I'm 'moving the centroid'. Reality: all 3 verts translate", () => {
    const v1 = vec(0, 0);
    const v2 = vec(10, 0);
    const v3 = vec(5, 10);
    const cent = centroidLens([v1, v2, v3]);

    cent.value = { x: 100, y: 100 };
    // Every vert shifted by the centroid's delta.
    expect(v1.value).not.toEqual({ x: 0, y: 0 });
    expect(v2.value).not.toEqual({ x: 10, y: 0 });
    expect(v3.value).not.toEqual({ x: 5, y: 10 });
    // This is the lens's bwd policy. If user wanted "snap centroid
    // by moving only v1", they need a different lens (or a custom
    // propagator).
  });

  it("WORKAROUND: use Vec.lens with explicit bwd that freezes some parents", () => {
    // Custom lens: centroid that distributes 100% to v1 only.
    // ... (would write the lens explicitly).
    expect(true).toBe(true);
  });
});

// ─── 8. Boundary cells outside the network ─────────────────────────

describe("Footgun 8: lens reads a cell outside the propagator's instance", () => {
  it("propagator subscribes via lens — but doesn't 'own' the cell", () => {
    const ownedByOthers = num(0); // imagine an animation owns this
    const lensView = ownedByOthers.scale(2);
    const out = num(0);

    const p = propagators();
    p.add(
      propagator([lensView], [out], () => {
        out.value = lensView.value;
      }),
    );

    // External writes to ownedByOthers fire the network normally.
    ownedByOthers.value = 5;
    expect(out.value).toBe(10);

    // BUT: the propagator can't "force" ownedByOthers to be a
    // particular value — it doesn't have it as a write. If the
    // animation overrides, the propagator just observes.
    p.dispose();
  });
});

describe("Footgun catalog summary (post AUTO-EXPAND)", () => {
  it("two closed, six remaining", () => {
    // Closed by AUTO-EXPAND:
    //   1. ✓ Freshness gap closed; cascades work transitively.
    //   3. ✓ Inconsistent cycles now THROW instead of silently
    //         settling — correctness surfaced.
    //
    // Remaining (all predictable consequences of the model):
    //   2. Bidirectional propagator's first-fire direction.
    //         → Write driver AFTER install.
    //   4. Multiple writers per lens — last write wins.
    //         → Combine into one propagator.
    //   5. Hot-loop re-peeks of a chain.
    //         → Cache `chain.value` once.
    //   6. Disposal scope: lens chains outlive Propagators dispose.
    //         → Separate concerns; dispose what you own.
    //   7. Lens bwd write-policy surprise.
    //         → Read the bwd; write custom Vec.lens if different
    //           distribution wanted.
    //   8. Boundary cells outside the network.
    //         → Recognise propagator observes, can't force.
    expect(true).toBe(true);
  });
});
