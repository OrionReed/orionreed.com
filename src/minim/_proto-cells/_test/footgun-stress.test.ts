// footgun-stress.test.ts — stress-test cases for the new fusion.
// Sequencing hazards, batch + relate interactions, deep chains,
// and other "this looks too fast, something must be wrong" probes.

import { describe, expect, it } from "vitest";
import { batch, computed, effect, num, Num, signal, transform, vec } from "../index";
import { relate } from "../relate";
import { Signal } from "../signal";
import { field } from "../writable";

describe("stress: many writes in sequence", () => {
  it("100 writes to tr.translate.x preserve correctness", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const x = tr.translate.x;
    let observedX = -1;
    const stop = effect(() => {
      observedX = x.value;
    });
    for (let i = 0; i < 100; i++) {
      x.value = i;
      expect(tr.value.translate.x).toBe(i);
      expect(tr.value.translate.y).toBe(0);
      expect(observedX).toBe(i);
    }
    stop();
  });

  it("alternating writes to .x and .y preserve both fields", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    for (let i = 0; i < 50; i++) {
      tr.translate.x.value = i * 2;
      tr.translate.y.value = i * 3;
      expect(tr.value.translate).toEqual({ x: i * 2, y: i * 3 });
    }
  });
});

describe("stress: deep nesting through field paths", () => {
  it("3-deep nested struct via lensTo + field works", () => {
    type S = { a: { b: { c: number; d: number } } };
    const root = new Signal<S>({ a: { b: { c: 1, d: 2 } } });
    // a → b → c. Use lensTo for first two layers (they're stateful
    // non-field, since lensTo doesn't pass fieldKey), and field for
    // the last. Tests the bug-fix case: field on top of non-field.
    const aLens = root.lensTo(
      Signal as new (...args: never[]) => Signal<S["a"]>,
      s => s.a,
      (v, s) => ({ ...s, a: v }),
    );
    const bLens = aLens.lensTo(
      Signal as new (...args: never[]) => Signal<S["a"]["b"]>,
      a => a.b,
      (v, a) => ({ ...a, b: v }),
    );
    const c = field(bLens, "c", Num);

    expect(c.value).toBe(1);
    (c as unknown as { value: number }).value = 99;
    expect(root.value).toEqual({ a: { b: { c: 99, d: 2 } } });
    // Sanity: d is untouched.
    expect(root.value.a.b.d).toBe(2);
  });
});

describe("stress: relate + batch", () => {
  it("relate inside batch: both writes apply once", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    let bFires = 0;
    let bValues: number[] = [];
    const stop = effect(() => {
      bValues.push(b.value);
      bFires++;
    });
    bFires = 0;
    bValues = [];

    batch(() => {
      a.value = 5;
      a.value = 10;
    });

    // Should see only the final state (b = 11) once.
    expect(bFires).toBe(1);
    expect(bValues).toEqual([11]);
    stop();
  });

  it("relate writes from both sides in batch: last write wins (a side)", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 100,
      y => y - 100,
    );

    batch(() => {
      a.value = 5; // would set b = 105
      b.value = 200; // would set a = 100
    });
    // After batch flushes, the relate effects run. Order is:
    //   e1 (a-driven, queued first) runs: reads a=5, writes b=105. But
    //     b was just written to 200 in the batch. So b's currentValue
    //     is 200 (committed lazily). e1 writes b.writeBack(105). b
    //     sees 200 → 105, propagates.
    //   e2 (b-driven) runs: reads b's new value (105), writes a=5.
    //     a's currentValue is 5. Same. No propagation.
    // Final: a=5, b=105. The "b = 200" write got overwritten by the
    // a-driven relate effect. This is a real footgun — concurrent
    // writes from both sides of a relation race based on effect order.
    // Not a regression but worth documenting.
    expect(a.value).toBe(5);
    expect(b.value).toBe(105);
  });
});

describe("stress: effect that writes own dep", () => {
  it("writeBack inside effect breaks the self-trigger loop", () => {
    const a = num(0);
    let count = 0;
    const stop = effect(() => {
      count++;
      const v = a.value;
      if (v < 50) {
        (a as unknown as { writeBack: (v: number) => void }).writeBack(v + 1);
      }
    });
    // The effect runs once, reads a=0, writeBacks a=1. exclusion
    // prevents re-trigger of THIS effect, so the propagate doesn't
    // re-queue it. But there's nothing else watching a, so no further
    // effects fire. The effect ran exactly once.
    //
    // BUT — if anyone else watches a, they'd be notified. So
    // writeBack only mutes the current effect, not all effects.
    expect(count).toBe(1);
    expect(a.value).toBe(1);
    stop();
  });

  it("plain set inside effect: engine RecursedCheck silently swallows self-trigger", () => {
    // FOOTGUN: writing a signal within an effect's body that subscribes
    // to that signal does NOT re-trigger the effect (the engine's
    // RecursedCheck prevents immediate self-trigger; the post-run
    // Pending flag is never enqueued because nothing else writes the
    // signal). The effect runs ONCE — the conditional re-run never
    // happens. This is the correct behavior for the "loop guard" but
    // it can surprise users who expect the effect to "drive" itself
    // toward a fixed point. Use `writeBack` for explicit self-mute
    // intent, or do the loop in a separate effect / outside an effect.
    const a = num(0);
    let count = 0;
    const stop = effect(() => {
      count++;
      const v = a.value;
      if (v < 50) a.value = v + 1;
    });
    expect(count).toBe(1); // single run
    expect(a.value).toBe(1); // single increment that landed
    stop();
  });
});

describe("stress: lazy intermediates with computed siblings", () => {
  it("tr.translate is shared by .x and .y; write to .x doesn't break .y derivative", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    const sum = computed(() => tr.translate.x.value + tr.translate.y.value);
    expect(sum.value).toBe(3);
    tr.translate.x.value = 10;
    expect(sum.value).toBe(12);
    tr.translate.y.value = 20;
    expect(sum.value).toBe(30);
  });
});

describe("stress: many fused chains on same root", () => {
  it("100 simultaneous field views on the same root", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const lenses: Array<Num> = [];
    for (let i = 0; i < 100; i++) {
      // All are aliases of tr.translate.x (lazy() caches per-key)
      lenses.push(tr.translate.x as Num);
    }
    // All identical (cached).
    for (const l of lenses) expect(l).toBe(lenses[0]);
    tr.translate.x.value = 42;
    for (const l of lenses) expect(l.value).toBe(42);
  });
});

describe("stress: disposal during flush", () => {
  it("disposing effect during its own run doesn't crash", () => {
    const a = num(0);
    let stop: (() => void) | undefined;
    let runs = 0;
    stop = effect(() => {
      runs++;
      void a.value;
      if (runs >= 2 && stop) stop();
    });
    a.value = 1; // triggers second run, which disposes
    a.value = 2; // shouldn't trigger anything
    expect(runs).toBe(2);
  });
});

describe("stress: conformance against original parity", () => {
  // Spot-check that prototype matches original on a few classic
  // scenarios that exercise glitch-freedom.
  it("multi-update batch with computed in middle", () => {
    const a = signal(1);
    const b = signal(2);
    const sum = computed(() => a.value + b.value);
    let observed: number[] = [];
    effect(() => {
      observed.push(sum.value);
    });
    observed = [];
    batch(() => {
      a.value = 10;
      b.value = 20;
    });
    expect(observed).toEqual([30]);
    batch(() => {
      a.value = 100;
      b.value = 200;
    });
    expect(observed).toEqual([30, 300]);
  });

  it("conditional dep tracking: dynamic deps update correctly", () => {
    const cond = signal(true);
    const a = signal(1);
    const b = signal(100);
    const c = computed(() => (cond.value ? a.value : b.value));
    let observed: number[] = [];
    effect(() => {
      observed.push(c.value);
    });
    observed = [];
    a.value = 2; // tracked
    expect(observed).toEqual([2]);
    cond.value = false; // switch deps to b
    expect(observed).toEqual([2, 100]);
    a.value = 3; // no longer tracked
    expect(observed).toEqual([2, 100]);
    b.value = 200; // now tracked
    expect(observed).toEqual([2, 100, 200]);
  });
});
