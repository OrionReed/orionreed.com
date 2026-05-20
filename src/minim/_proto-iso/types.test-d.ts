// Compile-only type-inference tests. Runs through tsc only; never
// executed. If anything in here triggers a type error, the prototype's
// type story is broken.
//
// Run with:  npx tsc --noEmit -p src/minim/_proto-iso/tsconfig.json
//
// The point of THIS file is the type assertions. We use `Assert<X>`
// to force unsatisfiable arms to surface as errors.

import { Signal, type Read } from "../signals/signal";
import { Chain, via } from "./iso";
import { field } from "./field";
import { mean, viaJoint } from "./joint";
import { Num, NumChain, num } from "./num";
import { Vec, VecChain, vec } from "./vec";

// ─── Helpers ──────────────────────────────────────────────────────────

type True<T extends true> = T;
type Eq<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
  ? true : false;
type Extends<X, Y> = X extends Y ? true : false;
/** Stricter than `extends Signal<T>`: `value` must be writable, not readonly.
 *  Catches the readonly-`value` case that `extends Signal<T>` misses. */
type Writable<X, T> = X extends { value: T }
  ? Eq<Pick<X, "value">, { value: T }>  // writable: `value: T` (not readonly)
  : false;

// ─── Chain identity & W-tracking ──────────────────────────────────────

{
  const c0 = Chain.of<number>();
  type _0 = True<Eq<typeof c0, Chain<number, number, true>>>;

  const c1 = c0.iso({ fwd: (n) => n + 1, bwd: (n) => n - 1 });
  type _1 = True<Eq<typeof c1, Chain<number, number, true>>>;

  // .ro downgrades W to false
  const c2 = c1.ro({ fwd: (n) => n * 2 });
  type _2 = True<Eq<typeof c2, Chain<number, number, false>>>;

  // .iso after .ro stays false (once downgraded, always downgraded)
  const c3 = c2.iso({ fwd: (n) => n + 1, bwd: (n) => n - 1 });
  type _3 = True<Eq<typeof c3, Chain<number, number, false>>>;

  // Type-changing iso (string from number)
  const c4 = c0.iso({ fwd: (n) => String(n), bwd: (s) => Number(s) });
  type _4 = True<Eq<typeof c4, Chain<number, string, true>>>;
}

// ─── via() return types ───────────────────────────────────────────────

{
  const sig = new Signal<number>(0);
  const chainW = Chain.of<number>()
    .iso({ fwd: (n) => n + 1, bwd: (n) => n - 1 });
  const r1 = via(sig, chainW);
  type _1 = True<Eq<typeof r1, Signal<number>>>;

  const chainRO = chainW.ro({ fwd: (n) => n * 2 });
  const r2 = via(sig, chainRO);
  type _2 = True<Eq<typeof r2, Read<number>>>;
}

// ─── Num chain ───────────────────────────────────────────────────────

{
  const n = num(5);

  // n.add(b) preserves writability → Num
  const a = n.add(3);
  type _1 = True<Writable<typeof a, number>>;
  a.value = 10; // writable

  // .scale preserves writability
  const b = n.scale(2);
  type _2 = True<Writable<typeof b, number>>;
  b.value = 10;

  // .clamp downgrades to read-only
  const c = n.clamp(0, 100);
  // @ts-expect-error — read-only, can't assign
  c.value = 10;

  // Fused derive: invertible chain stays writable
  const d = n.derive((ch) => ch.add(3).scale(2));
  type _4 = True<Writable<typeof d, number>>;
  d.value = 10;

  // Fused derive: any .ro step downgrades
  const e = n.derive((ch) => ch.add(3).clamp(0, 100));
  // @ts-expect-error — read-only, can't assign
  e.value = 10;
}

// ─── Vec chain ───────────────────────────────────────────────────────

{
  const v = vec(0, 0);

  // .add → writable Vec
  const a = v.add({ x: 1, y: 2 });
  type _1 = True<Writable<typeof a, { x: number; y: number }>>;
  a.value = { x: 5, y: 5 };

  // .right(n).down(m) is composed shifts; both invertible → Vec
  const b = v.right(10).down(20);
  type _2 = True<Writable<typeof b, { x: number; y: number }>>;
  b.value = { x: 0, y: 0 };

  // axis lens .x is writable Num
  const x = v.x;
  type _3 = True<Writable<typeof x, number>>;
  x.value = 100;

  // .magnitude is read-only
  const m = v.magnitude;
  // @ts-expect-error — magnitude is read-only
  m.value = 5;

  // .distance(other) is read-only
  const d = v.distance({ x: 3, y: 4 });
  // @ts-expect-error — distance is read-only
  d.value = 5;

  // .normalize() inside derive → read-only
  const n = v.derive((ch) => ch.normalize());
  // @ts-expect-error — normalize is read-only
  n.value = { x: 1, y: 0 };

  // .perp() is its own inverse → writable
  const p = v.perp();
  type _7 = True<Writable<typeof p, { x: number; y: number }>>;
  p.value = { x: 1, y: 0 };

  // Cross-class derive: VecChain → NumChain via .distance, read-only.
  const dist = v.deriveNum((ch) => ch.distance({ x: 0, y: 0 }));
  // @ts-expect-error — distance is read-only
  dist.value = 5;

  // Cross-class derive: VecChain.x is invertible → writable Num.
  const x2 = v.deriveNum((ch) => ch.x);
  type _9 = True<Writable<typeof x2, number>>;
  x2.value = 5;
}

// ─── field() composes inside a chain ──────────────────────────────────

{
  // box.x.add(5) → writable Num
  // Built manually: field("x") iso composed with add iso.
  const box = new Signal<{ x: number; y: number }>({ x: 0, y: 0 });
  const c = Chain.of<{ x: number; y: number }>()
    .iso(field<{ x: number; y: number }, "x">("x"))
    .iso({ fwd: (n: number) => n + 5, bwd: (n: number) => n - 5 });
  const r = via(box, c);
  type _1 = True<Eq<typeof r, Signal<number>>>;
  r.value = 15; // writes through field + add inverse
}

// ─── mean() is writable AND preserves class identity ──────────────────

{
  const a = num(0), b = num(0);
  const m = mean(a, b);
  // mean preserves the parts' class — so trait slots flow through.
  type _1 = True<Writable<typeof m, number>>;
  type _2 = True<Extends<typeof m, Num>>;
  m.value = 5; // distributes
  // Critically: mean-of-mean works because the result IS a Num.
  const m2 = mean(m, m);
  type _3 = True<Extends<typeof m2, Num>>;
  m2.value = 10;
}

// ─── Read-only joints stay Read<T> ───────────────────────────────────

{
  const a = num(0), b = num(0);
  const sum = viaJoint([a, b] as const, {
    fwd: (av, bv) => av + bv,
  });
  type _1 = True<Eq<typeof sum, Read<number>>>;
  // @ts-expect-error — read-only, type is Read<T>
  sum.value = 5;
}
