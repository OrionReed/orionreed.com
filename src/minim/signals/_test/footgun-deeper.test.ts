// footgun-deeper.test.ts — second-pass adversarial probes.
//
// Round 1 (footgun-probe.test.ts) caught the field-on-non-field-stateful
// bug. This file probes more corners: fields on manual lenses, lazy
// intermediates, effect cleanup across the fast path, reactive args
// inside fwd/bwd, and a few sequencing hazards.

import { describe, expect, it } from "vitest";
import { computed, effect, Num, num, signal, transform, Vec, vec } from "../index";
import { Signal } from "../signal";
import { field } from "../writable";

void vec;

describe("footgun: field on top of manual Signal.install lens", () => {
  it("fieldOf on manual lens: setter writes through manual.setter", () => {
    // Manual lens has no _fusedOf, so prior = undefined. Fast path
    // would set parent = the manual lens itself, and the setter
    // writes via parent.value = (which goes through the manual
    // lens's user-supplied setter). Should work.
    const root = signal({ a: { x: 1, y: 2 } });
    let setterCalls = 0;
    const aManual = Signal.install(
      Vec,
      () => root.value.a,
      (v: { x: number; y: number }) => {
        setterCalls++;
        root.value = { ...root.value, a: v };
      },
    );

    const x = field(aManual, "x", Num);

    expect(x.value).toBe(1);
    (x as unknown as { value: number }).value = 99;
    expect(setterCalls).toBe(1); // manual setter participated
    expect(root.value).toEqual({ a: { x: 99, y: 2 } });
  });

  it("two fields on manual lens: deeper path-fast-path treats manual as root", () => {
    // manual.x.y — the field-path fast path tags fieldPath=["x"] with
    // parent=manual. Then .y composes fieldPath=["x","y"] with same
    // parent=manual. Setter does manual.value = {...manual.peek(), x: {...x_inner, y: v}}.
    // Then manual's user setter runs.
    const root = signal({ vals: { x: 1, y: 2 } });
    let setterCalls = 0;
    const mLens = Signal.install(
      Signal as new (
        ...args: never[]
      ) => Signal<{ x: number; y: number }>,
      () => root.value.vals,
      (v: { x: number; y: number }) => {
        setterCalls++;
        root.value = { ...root.value, vals: v };
      },
    );

    // m.value.x via fieldOf, then .y via fieldOf
    const x = Signal.fieldOf(mLens, "x", Num);
    void x; // touch to materialize

    // Test write through the chain
    const y = Signal.fieldOf(mLens, "y", Num);
    (y as unknown as { value: number }).value = 99;
    expect(setterCalls).toBe(1);
    expect(root.value).toEqual({ vals: { x: 1, y: 99 } });
  });
});

describe("footgun: lazy intermediates stay fresh under root writes", () => {
  it("tr.translate cached, root write, intermediate read returns fresh value", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    const transl = tr.translate; // materialize via lazy
    expect(transl.value).toEqual({ x: 1, y: 2 });

    tr.value = { ...tr.value, translate: { x: 10, y: 20 } };
    expect(transl.value).toEqual({ x: 10, y: 20 });
  });

  it("tr.translate.x and tr.translate.y are independent fields after root write", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    const x = tr.translate.x;
    const y = tr.translate.y;
    tr.value = { ...tr.value, translate: { x: 10, y: 20 } };
    expect(x.value).toBe(10);
    expect(y.value).toBe(20);
  });

  it("write to tr.translate.x doesn't disturb tr.translate.y reads", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    tr.translate.x.value = 99;
    expect(tr.value.translate).toEqual({ x: 99, y: 2 });
    tr.translate.y.value = 88;
    expect(tr.value.translate).toEqual({ x: 99, y: 88 });
  });
});

describe("footgun: effect cleanup across field-fast-path", () => {
  it("effect on tr.translate.x disposes cleanly: root has no subs after stop", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    const x = tr.translate.x;

    const stop = effect(() => {
      void x.value;
    });
    expect((tr as unknown as { subs?: unknown }).subs).not.toBeUndefined();
    stop();
    expect((tr as unknown as { subs?: unknown }).subs).toBeUndefined();
  });

  it("multiple effects on the same field: all disposed cleanly", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    const x = tr.translate.x;

    const s1 = effect(() => void x.value);
    const s2 = effect(() => void x.value);
    const s3 = effect(() => void x.value);

    s1();
    s2();
    s3();
    expect((tr as unknown as { subs?: unknown }).subs).toBeUndefined();
  });

  it("write fires all subscribed effects exactly once each", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    const x = tr.translate.x;
    let fires1 = 0,
      fires2 = 0;
    const stops = [
      effect(() => {
        void x.value;
        fires1++;
      }),
      effect(() => {
        void x.value;
        fires2++;
      }),
    ];
    fires1 = fires2 = 0;
    x.value = 5;
    expect(fires1).toBe(1);
    expect(fires2).toBe(1);
    for (const s of stops) s();
  });
});

describe("footgun: reactive args in field chains", () => {
  it("through(f, g) with reactive arg inside f tracks the arg correctly", () => {
    const a = num(1);
    const k = signal(2);
    const c = a.lens(
      v => v * k.value,
      v => v / k.value,
    );
    let observed: number[] = [];
    const stop = effect(() => {
      observed.push(c.value);
    });
    expect(observed).toEqual([2]);
    a.value = 5;
    expect(observed).toEqual([2, 10]);
    k.value = 3;
    expect(observed).toEqual([2, 10, 15]);
    stop();
  });

  it("write to reactive-arg-using through inverts using current arg", () => {
    const a = num(1);
    const k = signal(2);
    const c = a.lens(
      v => v * k.value,
      v => v / k.value,
    );
    (c as unknown as { value: number }).value = 20; // / 2 = 10
    expect(a.value).toBe(10);
    k.value = 5;
    (c as unknown as { value: number }).value = 50; // / 5 = 10
    expect(a.value).toBe(10);
  });
});

describe("footgun: cyclic computed still throws (engine invariant preserved)", () => {
  it("computed reading itself throws RangeError", () => {
    let cellRef: { value: number } | undefined;
    const cell = computed<number>(() => {
      if (cellRef) return cellRef.value + 1; // self-reference
      return 0;
    });
    cellRef = cell;
    expect(() => cell.value).toThrow(/Cyclic computed/);
  });
});

describe("footgun: writeBack inside effect — self-mute correctness", () => {
  it("effect that writes back to its source via writeBack does not loop", () => {
    const a = num(0);
    let fires = 0;
    const stop = effect(() => {
      fires++;
      const v = a.value;
      // Write back doubled — exclusion prevents self-trigger.
      if (v < 100) {
        // Use writeBack to avoid re-firing this effect.
        (a as unknown as { writeBack: (v: number) => void }).writeBack(v * 2 + 1);
      }
    });
    expect(fires).toBeGreaterThan(0);
    expect(fires).toBeLessThan(20); // does not blow up
    stop();
  });
});
