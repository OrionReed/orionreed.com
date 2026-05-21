// types.test.ts — compile-time writability via Promote.

import { describe, it, expect } from "vitest";
import {
  num, vec, Num, Vec,
  type WritableNum, type WritableVec, type Writable,
  type Traits,
} from "../index";

describe("compile-time guarantees (Promote)", () => {
  it("placeholder — checks fire at tsc time", () => { expect(true).toBe(true) });
});

function _typeProbes(): void {
  // ─── Num ───────────────────────────────────────────────────────
  const a: WritableNum = num(0) as WritableNum;
  a.value = 5;

  const ro: Num = Num.derive(() => 1);
  // @ts-expect-error — Num bare class is RO at the public type level
  ro.value = 5;

  // ─── Vec ───────────────────────────────────────────────────────
  const v: WritableVec = vec(1, 2) as WritableVec;
  v.value = { x: 5, y: 5 };
  v.x.value = 99;                  // field lens auto-lifted to WritableNum

  const rov: Vec = v.normalize();
  // @ts-expect-error
  rov.value = { x: 0, y: 0 };
  // @ts-expect-error
  rov.x.value = 5;                 // field on RO Vec

  // Eager invertible chain — return type lifted to WritableVec by Promote
  const chain = v.add({ x: 1, y: 0 }).scale(2);
  chain.value = { x: 0, y: 0 };

  // Buggy fn caught locally
  function _buggy(p: Vec): void {
    // @ts-expect-error
    p.value = { x: 0, y: 0 };
    // @ts-expect-error
    p.x.value = 5;
  }
  void _buggy;

  // Animator-style sig: writable + traits
  function spring<T>(s: Writable<T> & Traits<T, "linear" | "metric">, target: T): void {
    s.value = target;
  }
  spring(v, { x: 0, y: 0 });        // WritableVec ⊆ Signal & traits
  spring(a, 5);
  // @ts-expect-error
  spring(rov, { x: 0, y: 0 });
}
_typeProbes;
if (Math.random() < -1) _typeProbes();
