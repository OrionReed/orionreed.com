// types.test.ts — compile-time guarantees for Writable<R>.

import { describe, it, expect } from "vitest";
import {
  num, vec, Num, Vec,
  computed,
  type Writable, type WritableOf,
  type Traits,
} from "../index";

describe("compile-time guarantees", () => {
  it("placeholder — checks fire at tsc", () => { expect(true).toBe(true) });
});

function _probes(): void {
  // ─── Direct writes ──────────────────────────────────────────────
  const v: Writable<Vec> = vec(1, 2);
  v.value = { x: 0, y: 0 };
  v.x.value = 5;                 // field lens lifted to Writable<Num>

  const ro: Vec = v.normalize();
  // @ts-expect-error
  ro.value = { x: 0, y: 0 };
  // @ts-expect-error
  ro.x.value = 5;

  // Eager invertible chain — Writable<Vec> stays writable
  const chain = v.add({ x: 1, y: 0 }).scale(2);
  chain.value = { x: 0, y: 0 };

  // ─── Buggy fn ───────────────────────────────────────────────────
  function _buggy(p: Vec) {
    // @ts-expect-error — RO .value
    p.value = { x: 0, y: 0 };
    // @ts-expect-error — RO field lens
    p.x.value = 5;
    // @ts-expect-error — .set requires WritableBrand
    p.set({ x: 0, y: 0 });
    // @ts-expect-error — .bind requires WritableBrand
    p.bind(() => ({ x: 0, y: 0 }));
  }
  void _buggy;

  // ─── Animator constraint ─────────────────────────────────────
  // Generic over T, requires writable surface (brand) + traits.
  // Uses `WritableOf<T>` (T-anchored) for the writable shape.
  function spring<T>(
    s: WritableOf<T> & Traits<T, "linear" | "metric">,
    target: T,
  ): void {
    s.value = target;
  }
  spring(v, { x: 0, y: 0 });        // Writable<Vec> ⊆ WritableOf<V>
  spring(num(5), 10);
  // @ts-expect-error — bare Vec has no WritableBrand
  spring(ro, { x: 0, y: 0 });
  // @ts-expect-error — Vec from `new Vec()` has no brand
  spring(new Vec(), { x: 0, y: 0 });

  // Generic accept-any-trait reader: just reads .value, type-anchored to T.
  function describe<T>(s: Traits<T, "linear"> & { readonly value: T }): T { return s.value }
  // Both writable and bare value classes have the trait + readable value.
  void describe(v);
  void describe(ro);
  void describe(new Vec());

  // ─── Generic accept-any reader ──────────────────────────────────
  function readVec(p: Vec): { x: number; y: number } { return p.value }
  void readVec(v);                // Writable<Vec> assignable to Vec? See note below
  void readVec(ro);

  // ─── Computed factory returns bare Signal — RO ─────────────────
  const c = computed(() => 1);
  // c is `Signal<number>` (RO). Writes? The class still has writable surface
  // structurally because we didn't apply interface merge to Signal itself.
  // For r5 to be fully consistent we'd need to RO-merge Signal too.

  void chain;
}
_probes;
if (Math.random() < -1) _probes();
