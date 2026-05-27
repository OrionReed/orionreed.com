// types.test.ts — compile-time guarantees for Writable<R>.

import { describe, expect, it } from "vitest";
import { derive, num, type Signal, type Traits, Vec, vec, type Writable } from "../index";

describe("compile-time guarantees", () => {
  it("placeholder — checks fire at tsc", () => {
    expect(true).toBe(true);
  });
});

function _probes(): void {
  // ─── Direct writes ──────────────────────────────────────────────
  const v: Writable<Vec> = vec(1, 2);
  v.value = { x: 0, y: 0 };
  v.x.value = 5; // field lens lifted to Writable<Num>

  // Bare-value-class direct writes ERROR at the type level. `Signal`
  // declares `value` as `readonly` (the runtime accessor is installed
  // on the prototype after class declaration); `Writable<R>` adds a
  // settable `value` via intersection.
  const ro: Vec = v.normalize();
  // @ts-expect-error — bare Vec.value is read-only at the type level
  ro.value = { x: 0, y: 0 };
  // @ts-expect-error — bare Vec.x → bare Num, also read-only
  ro.x.value = 5;

  // Eager invertible chain — Writable<Vec> stays writable
  const chain = v.add({ x: 1, y: 0 }).scale(2);
  chain.value = { x: 0, y: 0 };

  // Buggy fn — declaring a Vec parameter implies "RO surface."
  function _buggy(p: Vec) {
    // @ts-expect-error — RO .value
    p.value = { x: 0, y: 0 };
    // @ts-expect-error — RO field lens
    p.x.value = 5;
  }
  void _buggy;

  // ─── Animator constraint ─────────────────────────────────────
  // Generic over T, requires writable surface (brand) + listed
  // traits. The `_t` slot on each value class carries the static
  // traits dict at the type level, so `Traits<T, "linear" | "metric">`
  // can verify presence at compile time. Bare RO Vec is rejected
  // through the brand (separate axis from traits).
  function spring<T>(
    s: Writable<Signal<T>> & Traits<T, "linear" | "metric">,
    target: T,
  ): void {
    s.value = target;
  }
  spring(v, { x: 0, y: 0 }); // Writable<Vec> ⊆ Writable<Signal<V>>
  spring(num(5), 10);
  // @ts-expect-error — bare Vec has no WritableBrand
  spring(ro, { x: 0, y: 0 });
  // @ts-expect-error — Vec from `new Vec()` has no brand
  spring(new Vec(), { x: 0, y: 0 });

  // ─── Generic accept-any reader ──────────────────────────────────
  // Use `Read<Inner<Vec>>` for "any readable of vec-shape" parameters.
  // This accepts bare Vec, Writable<Vec>, custom readers — anything
  // with `{ readonly value: V; peek(): V }`. Stricter `(p: Vec)` only
  // accepts bare Vec instances (Writable<Vec>'s lifted invertibles
  // create structural mismatch under TS's recursive variance check).
  function readVec(p: import("../signal").Read<{ x: number; y: number }>) {
    return p.value;
  }
  void readVec(v); // ✓ Writable<Vec> has readable value
  void readVec(ro); // ✓ bare Vec
  void readVec({ value: { x: 0, y: 0 }, peek: () => ({ x: 0, y: 0 }) });

  // ─── Computed factory returns bare Signal — RO ─────────────────
  const c = derive(() => 1);
  // @ts-expect-error — bare `Signal<T>` is RO at the type level
  // (the class declares `readonly value: T`; the runtime accessor is
  // installed on the prototype). `signal(...)` returns
  // `Writable<Signal<T>>` for writable sources.
  c.value = 5;

  void chain;
}
_probes;
if (Math.random() < -1) _probes();
