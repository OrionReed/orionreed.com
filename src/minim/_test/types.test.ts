// types.test.ts — type-inference audit. Compile-only: every line must
// type-check WITHOUT casts at the user surface. Wrapped in a vitest
// `it` so failure shows up in the test runner; the body itself is
// never invoked at runtime (`return`).

import { describe, it } from "vitest";
import {
  signal, computed, effect, batch, untracked, value, isSignal,
  Signal,
  type Computed, type Lens,
  type Val,
  type SignalOptions,
  classOf, linearOf, lerpOf, requireLinear, requireLerp, requireMetric,
  LINEAR, LERP,
  type Linear, type Lerp,
  Vec, vec, Num, num, Color, rgb, Box, box, Transform, transform,
} from "@minim/signals";

describe("types", () => {
  it("compile-only audit (body never runs)", () => {
    if (true as boolean) return;  // skip body — type-check only

    // ── 1. Val<T> brand ──
    const _v1: Val<number> = 5;
    const _v2: Val<number> = () => 10;
    const _v3: Val<number> = signal(15);
    const _v4: Val<number> = computed(() => 20);

    // ── 2. Vec methods return Vec, chainable ──
    const v1: Vec = vec(1, 2);
    const _v6: Vec = v1.add({ x: 10, y: 20 });
    const _v7: Vec = v1.add({ x: 1, y: 1 }).scale(2);
    const _v8: Vec = v1.lerp(v1, 0.5);

    const x1: Num = v1.x;
    const _y1: Num = v1.y;
    const _x2: Num = x1.add(5);
    const _mag: Num = v1.magnitude;

    // ── 3. Method args accept Val<T> ──
    const offset = vec(5, 5);
    const _r1: Vec = v1.add(offset);
    const _r2: Vec = v1.add(() => ({ x: 1, y: 1 }));
    const _r3: Vec = v1.add({ x: 1, y: 1 });
    const numK = num(2);
    const _s1: Vec = v1.scale(numK);
    const _s2: Vec = v1.scale(() => 3);
    const _s3: Vec = v1.scale(2);

    // ── 4. classOf + per-trait accessors ──
    const klass = classOf(v1);
    const _vname: string = klass.name;
    const _linOpt: Linear<{ x: number; y: number }> | undefined = linearOf(v1);
    const _lerpOpt: Lerp<{ x: number; y: number }> | undefined = lerpOf(v1);
    const _linProto: Linear<{ x: number; y: number }> | undefined = Vec.prototype[LINEAR];
    const _lerpProto: Lerp<{ x: number; y: number }> | undefined = Vec.prototype[LERP];

    // ── 5. requireX accessors ──
    const linear = requireLinear(v1);
    const lerp = requireLerp(v1);
    const metric = requireMetric(v1);
    const _sum = linear.add({ x: 1, y: 1 }, { x: 2, y: 2 });
    const _mid = lerp({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.5);
    const _dist = metric({ x: 0, y: 0 }, { x: 3, y: 4 });

    // ── 6. Generic ops ──
    function mean<T>(...cells: Signal<T>[]): Computed<T> {
      const linear = requireLinear(cells[0]);
      const invN = 1 / cells.length;
      return computed(() => {
        let acc = cells[0].value;
        for (let i = 1; i < cells.length; i++) acc = linear.add(acc, cells[i].value);
        return linear.scale(acc, invN);
      });
    }
    const _avg: Computed<{ x: number; y: number }> = mean(vec(0, 0), vec(10, 10));

    // ── 7. Composite types ──
    const tr: Transform = transform({ opacity: 0.5 });
    const _trans: Vec = tr.translate;
    const _sc: Vec = tr.scale;
    const _rot: Num = tr.rotate;
    const _op: Num = tr.opacity;
    const _trMove: Vec = tr.translate.add({ x: 10, y: 0 });

    // ── 8. bind accepts Val<T> ──
    const target = signal(0);
    const _stop1: () => void = target.bind(5);
    const _stop2: () => void = target.bind(() => Date.now());
    const _stop3: () => void = target.bind(numK);

    // ── 9. value() handles every Val form ──
    const _u1: number = value(5);
    const _u2: number = value(() => 10);
    const _u3: number = value(signal(15));
    const _u4: { x: number; y: number } = value(vec(1, 2));

    // ── 10. isSignal narrows ──
    function _test(v: unknown) {
      if (isSignal(v)) void v.value;
      if (v instanceof Vec) void v.add({ x: 1, y: 1 });
    }

    // ── 11. SignalOptions hooks ──
    const _opts: SignalOptions = {
      watched: () => console.log("first subscriber"),
      unwatched: () => console.log("last subscriber gone"),
    };
    const _sig = new Signal(0, _opts);

    // ── Suppress unused warnings ──
    void _v1; void _v2; void _v3; void _v4; void _v6; void _v7; void _v8;
    void _y1; void _x2; void _mag; void _r1; void _r2; void _r3;
    void _s1; void _s2; void _s3; void _vname; void _linOpt; void _lerpOpt;
    void _linProto; void _lerpProto; void _sum; void _mid; void _dist;
    void _avg; void _trans; void _sc; void _rot; void _op; void _trMove;
    void _stop1; void _stop2; void _stop3; void _u1; void _u2; void _u3; void _u4;
    void _opts; void _sig; void _test;
    void [effect, batch, untracked, Computed, Lens, Color, rgb, Box, box];
  });
});
