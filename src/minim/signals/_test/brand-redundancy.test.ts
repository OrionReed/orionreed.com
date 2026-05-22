// brand-redundancy.test.ts — what `WritableBrand` catches that pure
// structural RO/RW matching does NOT.
//
// Empirical finding:
//
//   class Foo { get value(): number {…} set value(v: number) {…} }
//   interface Foo { get value(): number }    // interface merge
//
//   const f = new Foo();
//   f.value = 5;                               // ✗ "RO property" — interface RO wins
//   function takeRw(s: { value: number }) { s.value = 0 }
//   takeRw(f);                                 // ✓ ACCEPTED
//
// Why: TS enforces RO at direct-write sites, but is lenient at
// structural-parameter-passing — `Foo`'s getter is bivariantly
// compatible with `{ value: number }` because TS object-type variance
// doesn't propagate the function body's `s.value = …` write back to the
// parameter contract.
//
// `WritableBrand` plugs this hole. `WritableOf<T> extends WritableBrand`
// makes the parameter type nominal, so `takeRw(roVec)` is rejected
// even though the RO `.value` is structurally compatible.
//
// Conclusion: brand earns its keep. The probes below capture this.

import { describe, expect, it } from "vitest";
import { Vec, vec, type WritableOf } from "../index";

describe("WritableBrand earns its keep — structural-only is too lenient", () => {
  it("placeholder — checks fire at tsc", () => {
    expect(true).toBe(true);
  });
});

// Pure structural RW shape (no brand) — the lenient variant.
interface RwOnly<T> {
  value: T;
  peek(): T;
}
function takeStructural<T>(s: RwOnly<T>): void {
  s.value = s.peek();
}

// Branded RW shape — what minim actually uses.
function takeBranded<T>(s: WritableOf<T>): void {
  s.value = s.peek();
}

function _probes(): void {
  const roVec: Vec = new Vec();
  const wVec = vec(1, 2);

  // Structural-only: bare RO Vec is INCORRECTLY accepted (gap demoed).
  takeStructural(roVec); // would throw at runtime

  // Branded: bare RO Vec is correctly REJECTED at compile time.
  // @ts-expect-error — bare Vec lacks WritableBrand
  takeBranded(roVec);

  // Both forms accept legitimately writable values.
  takeStructural(wVec);
  takeBranded(wVec);
}
_probes;
if (Math.random() < -1) _probes();
