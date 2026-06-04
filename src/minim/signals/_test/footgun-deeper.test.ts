// footgun-deeper.test.ts — second-pass adversarial probes.
//
// Round 1 (footgun-probe.test.ts) caught the field-on-non-field-stateful
// bug. This file probes more corners: fields on manual lenses, lazy
// intermediates, effect cleanup across the fast path, reactive args
// inside fwd/bwd, and a few sequencing hazards.

import { describe, expect, it } from "vitest";
import { derive, effect, lens, Num, num, signal, transform, Vec, vec } from "../index";
import { Cell } from "../signal";
import { field } from "../writable";

void vec;

describe("footgun: field on top of a structural lens", () => {
  it("fieldOf on a source-reading lens: put writes through the lens bwd", () => {
    // The lens projects `root.value.a` and spreads it back on write. A
    // field on top composes its put into the lens's bwd, which should run
    // once and land the edit in the root.
    const root = signal({ a: { x: 1, y: 2 } });
    let bwdCalls = 0;
    const aLens = Vec.lens(
      root,
      s => s.a,
      (v, s) => {
        bwdCalls++;
        return { ...s, a: v };
      },
    );

    const x = field(aLens, "x", Num);

    expect(x.value).toBe(1);
    (x as unknown as { value: number }).value = 99;
    expect(bwdCalls).toBe(1); // lens bwd participated
    expect(root.value).toEqual({ a: { x: 99, y: 2 } });
  });

  it("two fields on a structural lens: deeper path composes through one bwd", () => {
    const root = signal({ vals: { x: 1, y: 2 } });
    let bwdCalls = 0;
    const mLens = lens(
      root,
      s => s.vals,
      (v: { x: number; y: number }, s) => {
        bwdCalls++;
        return { ...s, vals: v };
      },
    );

    // m.value.x via fieldOf, then .y via fieldOf
    const x = Cell.fieldOf(mLens, "x", Num);
    void x; // touch to materialize

    // Test write through the chain
    const y = Cell.fieldOf(mLens, "y", Num);
    (y as unknown as { value: number }).value = 99;
    expect(bwdCalls).toBe(1);
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
    const observed: number[] = [];
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
    const cell = derive<number>(() => {
      if (cellRef) return cellRef.value + 1; // self-reference
      return 0;
    });
    cellRef = cell;
    expect(() => cell.value).toThrow(/Cyclic computed/);
  });
});

describe("footgun: multi-parent short-circuit with a DERIVED parent", () => {
  it("write propagates when an unwritten parent is derived from the written one", () => {
    // The hazard: a Vec lens lists a DERIVED parent (`frame`, computed
    // from `translate`) AND the root `translate`; its fwd reads `frame`
    // but bwd writes `translate`. The view-change short-circuit substitutes
    // the written `translate` but PEEKS the stale `frame`, so fwd(cand)
    // looks unchanged and (with Vec's value equality) would wrongly absorb
    // the write. The engine must detect the derived parent and propagate.
    // (This is exactly shape.center: write the anchor → shift translate.)
    const translate = vec(0, 0);
    const box = signal({ x: 50, y: 70, w: 100, h: 60 });
    const frame = derive([translate] as const, ([t]) => ({ dx: t.x, dy: t.y }));

    const center = Vec.lens(
      [box, frame, translate] as const,
      ([b, f]) => ({ x: b.x + 0.5 * b.w + f.dx, y: b.y + 0.5 * b.h + f.dy }),
      (target, [b, f, tNow]) => {
        const cur = { x: b.x + 0.5 * b.w + f.dx, y: b.y + 0.5 * b.h + f.dy };
        return [
          undefined,
          undefined,
          { x: tNow.x + (target.x - cur.x), y: tNow.y + (target.y - cur.y) },
        ];
      },
    );

    expect(center.value).toEqual({ x: 100, y: 100 }); // realize a clean cache
    center.value = { x: 250, y: 300 };
    expect(translate.peek()).toEqual({ x: 150, y: 200 }); // write landed
    expect(center.value).toEqual({ x: 250, y: 300 });
  });

  it("still absorbs a true no-op write when all parents are independent sources", () => {
    // Soundness guard must NOT over-fire: with all-source parents the
    // short-circuit is valid and a same-view write is still absorbed,
    // preserving the sub-grid remainder spread across parents.
    const a = num(3);
    const b = num(4);
    // floor-of-sum view loses the fractional remainder of (a+b).
    const sum = Num.lens(
      [a, b] as const,
      ([av, bv]) => Math.floor(av + bv),
      t => [t - b.peek(), undefined],
    );
    expect(sum.value).toBe(7);
    a.value = 3.4; // a+b = 7.4 → floor still 7 (view unchanged)
    expect(sum.value).toBe(7);
    // Writing 7 (the current view) must be absorbed — the 0.4 remainder
    // in `a` survives rather than being flattened.
    sum.value = 7;
    expect(a.peek()).toBe(3.4);
  });
});
