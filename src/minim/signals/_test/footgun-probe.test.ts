// footgun-probe.test.ts — adversarial cases for the new fusion.
//
// Probes designed to expose subtle bugs in the field-path fast path
// and law-driven setter dispatch. If any of these fail, the
// optimisation has a hole.

import { describe, expect, it } from "vitest";
import { batch, effect, Num, num, Vec, vec } from "../index";
import { relate } from "../relate";
import { Signal } from "../signal";
import { field } from "../writable";

describe("footgun: field path on top of non-field stateful lens", () => {
  it("Cls.lens (non-field bwd shape) then field: write must traverse Cls.lens's bwd", () => {
    // The bwd of `Vec.lens(root, s => s.foo, (v, s) => ({ ...s, foo: v }))`
    // happens to be a field-set in shape, but Cls.lens doesn't tag it
    // with a `fieldKey`. The field-path optimisation MUST detect that
    // the prior chain is not field-tagged and fall back to the generic
    // composition — otherwise the write bypasses the lens entirely
    // and lands directly on the root with the wrong key.
    type S = { foo: { x: number; y: number } };
    const root = new Signal<S>({ foo: { x: 1, y: 2 } });
    const fooLens = Vec.lens(
      root,
      s => s.foo,
      (v, s) => ({ ...s, foo: v }),
    );
    const x = field(fooLens, "x", Num);

    expect(x.value).toBe(1);
    (x as unknown as { value: number }).value = 99;

    expect(root.value).toEqual({ foo: { x: 99, y: 2 } });
    expect(root.value.foo.x).toBe(99);
    expect((root.value as unknown as { x?: number }).x).toBeUndefined();
  });

  it("field then through (iso) then field: middle through must be honoured", () => {
    // root → translate(stateful) → scale(iso) → x(stateful field).
    // Writing x must traverse the chain: spread-replace at the scale
    // layer, then divide-by-2 (scale.bwd), then spread-replace at the
    // translate layer. If the field-path fast path mistakenly applied,
    // the `scale(2)` layer would be bypassed.
    type S = { translate: { x: number; y: number } };
    const root = new Signal<S>({ translate: { x: 4, y: 6 } });
    const translateLens = Vec.lens(
      root,
      s => s.translate,
      (vv, s) => ({ ...s, translate: vv }),
    );
    const scaled = translateLens.scale(2);
    const x = field(scaled, "x", Num);

    expect(x.value).toBe(8);

    (x as unknown as { value: number }).value = 20;
    // bwd chain: field.bwd produces {x:20, y:12} (spread scale's
    // current state with x=20). scale.bwd halves both axes → {x:10, y:6}.
    // translate.bwd writes that into root.translate.
    expect(root.value).toEqual({ translate: { x: 10, y: 6 } });
  });
});

describe("statefulness: arity-inferred (no explicit law tag needed)", () => {
  it("1-arg bwd → engine treats as stateless; bwd never receives s", () => {
    // Arity-based dispatch: bwd.length === 1 → stateless setter.
    // The engine doesn't compute or pass s.
    const a = num(10);
    let bwdCalled = false;
    const c = a.lens(
      v => v + 1,
      v => {
        bwdCalled = true;
        return v - 1;
      },
    );

    (c as unknown as { value: number }).value = 5;
    expect(bwdCalled).toBe(true);
    expect(a.value).toBe(4);
  });

  it("2-arg bwd → engine treats as stateful; s is the prior-fwd value", () => {
    const a = num(10);
    let receivedS: unknown = "unset";
    const c = a.lens(
      v => v + 100,
      (v, s) => {
        receivedS = s;
        return v - 100;
      },
    );

    (c as unknown as { value: number }).value = 105;
    expect(receivedS).toBe(10); // genuine prior state
    expect(a.value).toBe(5);
  });

  it("FOOTGUN: default args reduce arity (caveat)", () => {
    // `(v, s = 0) => …` reports length === 1 (default args reduce
    // Function.length). Engine treats as stateless, default s=0
    // kicks in. Subtle bug surface — declare without defaults if you
    // need real receiver state.
    const a = num(10);
    let observedS = -1;
    const c = a.lens(
      v => v,
      (v, s = 0) => {
        observedS = s;
        return v;
      },
    );

    (c as unknown as { value: number }).value = 7;
    // Despite the chain logically being stateful, arity-inferred as
    // stateless → s=0 always.
    expect(observedS).toBe(0);
  });
});

describe("footgun: equality + structural value classes", () => {
  it("Num equality short-circuits on identical writes", () => {
    const a = num(5);
    let fires = 0;
    const stop = effect(() => {
      void a.value;
      fires++;
    });
    expect(fires).toBe(1);
    a.value = 5;
    expect(fires).toBe(1);
    a.value = 6;
    expect(fires).toBe(2);
    stop();
  });

  it("Vec equality is structural; writing same x,y stops propagation", () => {
    const v = vec(3, 4);
    let fires = 0;
    const stop = effect(() => {
      void v.value;
      fires++;
    });
    expect(fires).toBe(1);
    v.value = { x: 3, y: 4 }; // structurally same
    expect(fires).toBe(1);
    v.value = { x: 5, y: 4 };
    expect(fires).toBe(2);
    stop();
  });
});

describe("footgun: chained writes inside batch fire once", () => {
  it("two writes in batch fire downstream effect once", () => {
    const a = num(1);
    const b = num(2);
    let fires = 0;
    const sumLog: number[] = [];
    const stop = effect(() => {
      const x = a.value + b.value;
      sumLog.push(x);
      fires++;
    });
    fires = 0;
    sumLog.length = 0;

    batch(() => {
      a.value = 10;
      b.value = 20;
    });

    expect(fires).toBe(1);
    expect(sumLog).toEqual([30]);
    stop();
  });
});

describe("footgun: relate behavior", () => {
  it("Iso relate terminates on initial setup", () => {
    const a = num(0);
    const b = num(0);
    const r = relate(
      a,
      b,
      x => x + 100,
      y => y - 100,
    );
    expect(a.value).toBe(0);
    expect(b.value).toBe(100);
    r.dispose();
  });

  it("write to one side propagates exactly once to a downstream effect", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    let bFires = 0;
    const stop = effect(() => {
      void b.value;
      bFires++;
    });
    bFires = 0;

    a.value = 5;
    expect(b.value).toBe(6);
    expect(bFires).toBe(1);
    stop();
  });
});
