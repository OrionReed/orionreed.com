// types.test.ts — comprehensive type-level guarantees for the spike's
// new `Writable<R>` design (registry-based, single-hop, no recursion).
//
// Every probe is either a positive accept (compiles) or a negative
// `// @ts-expect-error`. If `tsc --noEmit` passes, all probes fire
// correctly. The runtime body is just a placeholder.

import { describe, expect, it } from "vitest";
import { spring, tween, type Traits } from "../../index";
import {
  Hsl,
  hsl,
  Num,
  num,
  Transform,
  transform,
  Vec,
  vec,
  type Writable,
  type WritableOf,
} from "../index";

describe("spike type probes", () => {
  it("placeholder — guarantees fire at tsc", () => {
    expect(true).toBe(true);
  });
});

function _probes(): void {
  // ─── 1. Direct writes: factory return is writable ───────────────
  const v = vec(1, 2);
  v.value = { x: 0, y: 0 };
  v.x.value = 5;

  // ─── 2. Derived RO views block writes ───────────────────────────
  const ro = v.normalize();
  // @ts-expect-error — Vec.normalize() returns bare Vec (RO)
  ro.value = { x: 0, y: 0 };
  // @ts-expect-error — bare Vec.x is bare Num (RO)
  ro.x.value = 5;

  // ─── 3. Vec.derive(fn) returns bare Vec (RO) ────────────────────
  const d = Vec.derive(() => ({ x: 1, y: 2 }));
  // @ts-expect-error
  d.value = { x: 0, y: 0 };

  // ─── 4. Vec.lens(g, s) returns Writable<Vec> ────────────────────
  const l = Vec.lens(
    () => ({ x: 0, y: 0 }),
    () => {},
  );
  l.value = { x: 5, y: 5 };

  // ─── 5. Invertible chains preserve writability via `this` ──────
  const c1 = v.add({ x: 1, y: 0 });
  c1.value = { x: 0, y: 0 };
  const c2 = v.add({ x: 1, y: 0 }).scale(2).offset(1, 1);
  c2.value = { x: 0, y: 0 };

  // RO chain stays RO
  const c3 = ro.add({ x: 1, y: 0 });
  // @ts-expect-error — chain stays RO via `this`
  c3.value = { x: 0, y: 0 };

  // ─── 6. Non-invertible always returns RO regardless of receiver ─
  const c4 = v.normalize();
  // @ts-expect-error
  c4.value = { x: 0, y: 0 };
  const c5 = v.add({ x: 1, y: 0 }).normalize();
  // @ts-expect-error — chain "loses" writability at non-invertible step
  c5.value = { x: 0, y: 0 };

  // ─── 7. Field-lens invertible chain stays writable ──────────────
  const cx = v.x.add(5);
  cx.value = 10;

  // ─── 8. Animator constraints reject bare RO ─────────────────────
  spring(v, { x: 0, y: 0 });
  spring(num(5), 10);
  // @ts-expect-error — bare Vec lacks WritableBrand
  spring(ro, { x: 0, y: 0 });
  // @ts-expect-error — bare Vec from `new Vec()`
  spring(new Vec(), { x: 0, y: 0 });

  // ─── 9. Tween: `this: Writable<R>` constraint ───────────────────
  const t1 = v.to({ x: 1, y: 1 }, 0.3);
  void t1;
  // @ts-expect-error — `to` requires writable receiver
  ro.to({ x: 1, y: 1 }, 0.3);

  // ─── 10. Nested writability via Transform.translate ────────────
  const tr = transform();
  tr.translate.x.value = 5;
  tr.translate.value = { x: 0, y: 0 };
  tr.rotate.value = 1;
  tr.opacity.value = 0.5;

  const roTr = Transform.derive(() => ({
    translate: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    origin: { x: 0, y: 0 },
    rotate: 0,
    opacity: 1,
  }));
  // @ts-expect-error
  roTr.translate.x.value = 5;
  // @ts-expect-error
  roTr.translate.value = { x: 0, y: 0 };
  // @ts-expect-error
  roTr.rotate.value = 1;

  // ─── 11. Read-only consumer accepts both forms ─────────────────
  function readVec(p: { readonly value: { x: number; y: number } }): number {
    return p.value.x;
  }
  void readVec(v); // ✓ writable structurally compatible
  void readVec(ro); // ✓ RO is exactly what readVec expects
  void readVec(new Vec());

  // ─── 12. Generic with Traits constraint accepts both ────────────
  function describeIt<T>(s: { readonly value: T } & Traits<T, "linear">): T {
    return s.value;
  }
  void describeIt(v);
  void describeIt(ro);

  // ─── 13. User-defined value class — Hsl ────────────────────────
  const h = hsl(0.5, 0.7, 0.3);
  h.value = { h: 0.1, s: 0.2, l: 0.3 };
  h.h.value = 0.42; // Hsl.h is Writable<Num> on writable Hsl

  const roH = Hsl.derive(() => ({ h: 0, s: 0, l: 0 }));
  // @ts-expect-error
  roH.value = { h: 0, s: 0, l: 0 };
  // @ts-expect-error
  roH.h.value = 5;

  // Invertible chain on writable Hsl stays writable
  const hChain = h.add({ h: 0.1, s: 0.2, l: 0.3 }).scale(2);
  hChain.value = { h: 1, s: 1, l: 1 };

  // ─── 14. Writable<R> type alias resolves correctly ─────────────
  type CheckV = Writable<Vec>;
  const _check: CheckV = v;
  void _check;

  // ─── 14b. Inherits<this, T>-conditional getters: bare → RO, writable → RW ─
  // Bare Vec.x is Num (RO Num)
  const xRO: import("../num").Num = ro.x;
  void xRO;
  // Writable Vec.x is Num_W (RW)
  const xRW: import("../num").Num_W = v.x;
  void xRW;
  // @ts-expect-error — bare .x is not Num_W
  const _xMis: import("../num").Num_W = ro.x;
  void _xMis;

  // ─── 14c. Derived RO views stay RO on writable receivers ────────
  // `magnitude` is explicitly typed as Num (no `Inherits` conditional);
  // even on a writable Vec, magnitude.value can't be written. Today's
  // recursive `LiftField` would make this writable — a type lie since
  // magnitude is `deriveTo` (RO) at runtime.
  // @ts-expect-error
  v.magnitude.value = 10;
  // @ts-expect-error
  ro.magnitude.value = 10;

  // ─── 15. WritableOf<T> rejects RO via brand ────────────────────
  function takeWO<T>(s: WritableOf<T>): void {
    s.value = s.peek();
  }
  takeWO(num(5));
  // @ts-expect-error — bare Num lacks brand
  takeWO(new Num());

  // ─── Sink references so TS doesn't trim them ────────────────────
  void c1;
  void c2;
  void c3;
  void c4;
  void c5;
  void cx;
  void l;
  void d;
  void hChain;
}
_probes;
if (Math.random() < -1) _probes();
