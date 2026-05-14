// Test the per-arity unrolling. struct.ts has unrolled cases for:
//   - lift: arity 0, 1, 2; arity 3+ falls back to generic (.map)
//   - axisWriters (with .construct): arity 1, 2, 4, 6; others use a
//     fixed-size args-array fallback
//
// We construct test structs of varying arities and measure to see if
// the unrolling pays off. If the diff between arity-2 and arity-3 (or
// arity-6 vs arity-7) is small, the unrolling can be collapsed for a
// significant LOC reduction.

import { struct } from "@minim/signals";
import { bench, group } from "mitata";

// ── Lifter arity benches ────────────────────────────────────────────
//
// Define structs with ops of arity 0, 1, 2, 3, 4 returning S.
// Use simple ops that do the same total work, just with different
// arg counts, so any cost difference reflects dispatch overhead.

type S1 = { a: number };
const Str1 = struct<S1>("Str1", { a: 0 })
  .construct((a: number): S1 => ({ a }))
  .ops({
    op0: (s): S1 => ({ a: s.a + 1 }),
    op1: (s, x: number): S1 => ({ a: s.a + x }),
    op2: (s, x: number, y: number): S1 => ({ a: s.a + x + y }),
    op3: (s, x: number, y: number, z: number): S1 => ({ a: s.a + x + y + z }),
    op4: (s, x: number, y: number, z: number, w: number): S1 => ({
      a: s.a + x + y + z + w,
    }),
  })
  .build();

group("lifter arity (closure dispatch overhead)", () => {
  const v: any = Str1.signal({ a: 1 });
  // Pre-build the derived; iterate by writing + reading.
  const d0 = v.op0();
  const d1 = v.op1(1);
  const d2 = v.op2(1, 2);
  const d3 = v.op3(1, 2, 3);
  const d4 = v.op4(1, 2, 3, 4);

  let i = 0;
  bench("arity 0 (lifted0, unrolled)", () => {
    v.a.value = ++i;
    return d0.value;
  }).baseline(true);
  bench("arity 1 (lifted1, unrolled)", () => {
    v.a.value = ++i;
    return d1.value;
  });
  bench("arity 2 (lifted2, unrolled)", () => {
    v.a.value = ++i;
    return d2.value;
  });
  bench("arity 3 (liftedN, generic)", () => {
    v.a.value = ++i;
    return d3.value;
  });
  bench("arity 4 (liftedN, generic)", () => {
    v.a.value = ++i;
    return d4.value;
  });
});

// ── Axis-writer arity benches (with .construct) ─────────────────────

const A1 = struct<{ a: number }>("A1", { a: 0 })
  .construct((a: number) => ({ a }))
  .build();
const A2 = struct<{ a: number; b: number }>("A2", { a: 0, b: 0 })
  .construct((a: number, b: number) => ({ a, b }))
  .build();
const A3 = struct<{ a: number; b: number; c: number }>("A3", {
  a: 0,
  b: 0,
  c: 0,
})
  .construct((a: number, b: number, c: number) => ({ a, b, c }))
  .build();
const A4 = struct<{ a: number; b: number; c: number; d: number }>("A4", {
  a: 0,
  b: 0,
  c: 0,
  d: 0,
})
  .construct((a: number, b: number, c: number, d: number) => ({ a, b, c, d }))
  .build();
const A5 = struct<{
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
}>("A5", { a: 0, b: 0, c: 0, d: 0, e: 0 })
  .construct((a: number, b: number, c: number, d: number, e: number) => ({
    a, b, c, d, e,
  }))
  .build();
const A6 = struct<{
  a: number; b: number; c: number; d: number; e: number; f: number;
}>("A6", { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })
  .construct(
    (a: number, b: number, c: number, d: number, e: number, f: number) => ({
      a, b, c, d, e, f,
    }),
  )
  .build();
const A7 = struct<{
  a: number; b: number; c: number; d: number; e: number; f: number; g: number;
}>("A7", { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 })
  .construct(
    (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => ({
      a, b, c, d, e, f, g,
    }),
  )
  .build();

group("axis writer arity (with .construct, no subscribers)", () => {
  const s1: any = A1.signal({ a: 0 });
  const s2: any = A2.signal({ a: 0, b: 0 });
  const s3: any = A3.signal({ a: 0, b: 0, c: 0 });
  const s4: any = A4.signal({ a: 0, b: 0, c: 0, d: 0 });
  const s5: any = A5.signal({ a: 0, b: 0, c: 0, d: 0, e: 0 });
  const s6: any = A6.signal({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
  const s7: any = A7.signal({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 });
  // Cache the lenses
  void s1.a;
  void s2.a;
  void s3.a;
  void s4.a;
  void s5.a;
  void s6.a;
  void s7.a;

  let i = 0;
  bench("arity 1 (unrolled)", () => {
    s1.a.value = ++i;
  }).baseline(true);
  bench("arity 2 (unrolled)", () => {
    s2.a.value = ++i;
  });
  bench("arity 3 (generic loop)", () => {
    s3.a.value = ++i;
  });
  bench("arity 4 (unrolled)", () => {
    s4.a.value = ++i;
  });
  bench("arity 5 (generic loop)", () => {
    s5.a.value = ++i;
  });
  bench("arity 6 (unrolled)", () => {
    s6.a.value = ++i;
  });
  bench("arity 7 (generic loop)", () => {
    s7.a.value = ++i;
  });
});

// ── Spread-fallback writer (no .construct) ──────────────────────────
//
// When .construct is omitted, the framework uses object-spread writers
// instead. The comment in struct.ts claims ~30% slower; let's check.

const Sp2 = struct<{ a: number; b: number }>("Sp2", { a: 0, b: 0 }).build();
const Sp4 = struct<{ a: number; b: number; c: number; d: number }>("Sp4", {
  a: 0,
  b: 0,
  c: 0,
  d: 0,
}).build();

group("axis writer: construct-based vs spread fallback", () => {
  const c2: any = A2.signal({ a: 0, b: 0 });
  const sp2: any = Sp2.signal({ a: 0, b: 0 });
  const c4: any = A4.signal({ a: 0, b: 0, c: 0, d: 0 });
  const sp4: any = Sp4.signal({ a: 0, b: 0, c: 0, d: 0 });
  void c2.a;
  void sp2.a;
  void c4.a;
  void sp4.a;

  let i = 0;
  bench("arity 2: construct-based", () => {
    c2.a.value = ++i;
  }).baseline(true);
  bench("arity 2: spread fallback", () => {
    sp2.a.value = ++i;
  });
  bench("arity 4: construct-based", () => {
    c4.a.value = ++i;
  });
  bench("arity 4: spread fallback", () => {
    sp4.a.value = ++i;
  });
});
