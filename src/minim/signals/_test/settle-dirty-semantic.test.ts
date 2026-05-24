// settle-dirty-semantic.test.ts — probe whether `dirty` should
// include newly-subscribed signals (in addition to value-changed ones).
//
// Three concrete kernel shapes show how the current semantic
// (dirty = prev-deps with changed values, fresh subs not included)
// plays out vs the alternative (dirty = changed ∪ fresh):
//
//   1. Dynamic relations: cluster adds/removes relations over time.
//   2. Conditional reads: body reads different signals based on a flag.
//   3. Single-settle relate: relies on `dirty.size === 0` for "first run".
//
// Conclusion at the end of file documents the choice.

import { describe, expect, it } from "vitest";
import { batch, settle, signal, type Signal } from "../index";

// ─── 1. Dynamic relations ──────────────────────────────────────────
//
// AVBD-style kernel: relations added at runtime; their member signals
// become new deps. Question: does the kernel's structural-update code
// get cleaner if `dirty` includes fresh subs?

interface Slot {
  pulled: number;
}

describe("dirty semantic — dynamic relations", () => {
  it("kernel can handle 'new relation added' via its own active set, no need for fresh-in-dirty", () => {
    type Rel = { a: Signal<number>; b: Signal<number> };
    const active = new Set<Rel>();
    const slots = new Map<Signal<unknown>, Slot>();
    let pullsThisFire: Signal<unknown>[] = [];

    const handle = settle(dirty => {
      pullsThisFire = [];

      // Phase 1: structural — ensure slots for every member of every
      // active relation. Pull eagerly for new slots (because dirty
      // doesn't include fresh subs).
      const live = new Set<Signal<unknown>>();
      for (const r of active) {
        live.add(r.a as Signal<unknown>);
        live.add(r.b as Signal<unknown>);
      }
      for (const sig of live) {
        if (!slots.has(sig)) {
          slots.set(sig, { pulled: 0 });
          // Eager pull on alloc.
          (sig as Signal<number>).value;
          pullsThisFire.push(sig);
        }
      }
      for (const [sig, _slot] of slots) {
        if (!live.has(sig)) slots.delete(sig);
      }

      // Phase 2: incremental — pull whatever's in dirty.
      for (const sig of dirty) {
        (sig as Signal<number>).value;
        pullsThisFire.push(sig);
      }
    });

    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const r1 = { a, b };

    active.add(r1);
    handle.flush();
    // First time r1 added: a, b are fresh subs. Pulled via Phase 1 (alloc).
    expect(pullsThisFire).toContain(a);
    expect(pullsThisFire).toContain(b);

    // Mutate a — should appear in dirty, pulled via Phase 2.
    a.value = 10;
    expect(pullsThisFire).toEqual([a]);

    // Add r2 = (b, c) — b already a slot; c is fresh.
    const r2 = { a: b, b: c };
    active.add(r2);
    handle.flush();
    // c is fresh sub → Phase 1 pulled it. b/c neither in dirty (no value change).
    expect(pullsThisFire).toContain(c);
    expect(pullsThisFire).not.toContain(a); // not in active anymore? actually still is
    expect(pullsThisFire).not.toContain(b); // wasn't a fresh sub, not in dirty

    // Remove r1 — a is now orphaned. Phase 1 deletes its slot. b stays (in r2).
    active.delete(r1);
    handle.flush();
    expect(slots.has(a)).toBe(false);
    expect(slots.has(b)).toBe(true);
    expect(slots.has(c)).toBe(true);

    handle.dispose();
  });
});

// ─── 2. Conditional reads ───────────────────────────────────────────
//
// Body reads sigA or sigB depending on a flag. When flag flips, the
// body's dep set changes (sigA leaves, sigB joins or vice versa).

describe("dirty semantic — conditional reads", () => {
  it("flipping the flag changes deps; sigB is fresh next run, sigA is gone", () => {
    const flag = signal<"a" | "b">("a");
    const sigA = signal(10);
    const sigB = signal(20);
    let observed = 0;
    let lastDirtySize: number | undefined;

    const handle = settle(dirty => {
      lastDirtySize = dirty.size;
      observed = flag.value === "a" ? sigA.value : sigB.value;
    });
    expect(observed).toBe(10);
    expect(lastDirtySize).toBe(0); // first run

    // Flip flag — body re-runs, now reads sigB instead of sigA.
    flag.value = "b";
    expect(observed).toBe(20);
    // dirty currently contains: flag (changed). sigB is a fresh sub.
    // With current semantic: dirty = {flag}, sigB not in it.
    expect(lastDirtySize).toBe(1);

    // Mutate sigA — body should NOT re-fire (no longer a dep).
    sigA.value = 99;
    expect(observed).toBe(20); // unchanged

    // Mutate sigB — body re-fires.
    sigB.value = 30;
    expect(observed).toBe(30);

    handle.dispose();
  });
});

// ─── 3. Single-settle relate (first-run convention) ────────────────
//
// `dirty.size === 0` is the natural first-run signal. If dirty
// included fresh subs, first run would have dirty = {a, b} — ambiguous
// with "user wrote both in one batch."

describe("dirty semantic — single-settle relate", () => {
  it("dirty.size === 0 cleanly distinguishes 'first run' from 'both sides written'", () => {
    const a = signal(0);
    const b = signal(0);
    const transitions: Array<"first" | "fwd" | "bwd" | "both"> = [];

    const handle = settle(dirty => {
      const aHot = dirty.has(a as Signal<unknown>);
      const bHot = dirty.has(b as Signal<unknown>);
      // We MUST read both to subscribe. Reading them after the dirty checks
      // means the previous run's snapshot is what dirty refers to.
      a.value;
      b.value;
      if (dirty.size === 0) transitions.push("first");
      else if (aHot && bHot) transitions.push("both");
      else if (aHot) transitions.push("fwd");
      else if (bHot) transitions.push("bwd");
    });
    expect(transitions).toEqual(["first"]);

    a.value = 5;
    expect(transitions).toEqual(["first", "fwd"]);

    b.value = 10;
    expect(transitions).toEqual(["first", "fwd", "bwd"]);

    // Both written in one batch → both hot.
    batch(() => {
      a.value = 100;
      b.value = 200;
    });
    expect(transitions).toEqual(["first", "fwd", "bwd", "both"]);

    handle.dispose();
  });
});

// ─── Summary ────────────────────────────────────────────────────────
//
// Conclusion (drawn from the three probes):
//
//   - Dynamic relations: kernel needs structural tracking (active set)
//     anyway; fresh-in-dirty doesn't simplify enough to justify.
//
//   - Conditional reads: body's reads naturally wire up; fresh-in-dirty
//     would just add noise (sigB appearing in dirty before its first
//     real value change).
//
//   - Single-settle relate: `dirty.size === 0` is a clean first-run
//     signal; if fresh-included, first run = {a, b} = "both written"
//     ambiguity. Loss.
//
// Verdict: KEEP current semantic. dirty = previously-subscribed signals
// with new values. Newly-subscribed signals are NOT in dirty. Kernels
// that need structural change tracking maintain their own active set
// (which they need anyway for add/remove bookkeeping).
//
// If a future kernel really needs "what's new" as a separate concern,
// it can be added as a second arg without breaking existing usage:
//   settle((dirty, fresh) => ...)
// But no current need.
