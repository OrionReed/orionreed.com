// types.test.ts — compile-time writability guarantees.
//
// All assertions here fire at `tsc` time; the runtime body never
// executes (gated by `Math.random() < -1`). The vitest wrapper just
// ensures the file is compiled.

import { describe, it, expect } from "vitest";
import {
  num, vec,
  type Num, type WritableNum,
  type Vec, type WritableVec,
  type Writable,
  NumComputed, VecComputed, NumLens, VecLens,
} from "../index";
import type { Traits } from "../traits";

describe("compile-time type guarantees", () => {
  it("type-only probes (verified at tsc time)", () => { expect(true).toBe(true) });
});

// Functions exist purely to anchor type checks; never called.
function _typeProbes(): void {
  // ─── Num ───────────────────────────────────────────────────────
  const a: WritableNum = num(0);
  a.value = 5;                // OK

  // Direct: NumComputed has RO value
  const ck: NumComputed = new NumComputed(() => 1);
  // @ts-expect-error
  ck.value = 5;

  // Num is the structural RO surface; writes rejected
  const b: Num = num(0);
  // @ts-expect-error
  b.value = 5;
  // @ts-expect-error
  (b as Num).add?.(2);        // add not on Num structural type

  const c = num(3);
  const sum = c.add(2);       // NumLens
  sum.value = 10;             // OK (write-through)

  // ─── Vec ───────────────────────────────────────────────────────
  const v = vec(1, 2);        // VecSignal
  v.value = { x: 5, y: 5 };
  v.x.value = 99;             // writable field lens

  const ro = v.normalize();   // VecComputed
  // @ts-expect-error
  ro.value = { x: 0, y: 0 };
  // @ts-expect-error
  ro.x.value = 5;             // RO field on RO Vec

  // ─── Eager chain capability ────────────────────────────────────
  const chained = v.add({ x: 1, y: 0 }).scale(2);  // VecLens
  chained.value = { x: 0, y: 0 };
  chained.x.value = 7;

  // ─── Buggy function caught locally ─────────────────────────────
  function _buggy(p: Vec): void {
    // @ts-expect-error
    p.value = { x: 0, y: 0 };
    // @ts-expect-error
    p.x.value = 5;
  }
  void _buggy;

  // ─── Generic accept-any-flavour signature ─────────────────────
  function readVec(p: Vec): { x: number; y: number } { return p.value }
  // All three concrete classes are assignable to the structural Vec
  void readVec(v);                    // VecSignal ✓
  void readVec(v.normalize());        // VecComputed ✓
  void readVec(v.add({ x: 0, y: 0 })); // VecLens ✓

  // ─── Shape with writable Vec field ─────────────────────────────
  interface Draggable { readonly pos: WritableVec }
  function drag(d: Draggable, delta: { x: number; y: number }): void {
    d.pos.value = { x: d.pos.value.x + delta.x, y: d.pos.value.y + delta.y };
  }
  void drag;

  // ─── Animator-style trait constraint accepts writables w/ trait ─
  function spring<T>(s: Writable<T> & Traits<T, "linear" | "metric">, target: T): void {
    s.value = target;
  }
  spring(v, { x: 0, y: 0 });           // VecSignal — Signal<V> + linear+metric ✓
  spring(a, 5);                         // NumSignal — same
  // @ts-expect-error — VecComputed is NOT in Writable<T> = Signal | Lens
  spring(ro, { x: 0, y: 0 });

  void [b, sum, NumComputed, VecComputed, NumLens, VecLens];
}
_typeProbes;  // reference to silence "unused" warnings
if (Math.random() < -1) _typeProbes();
