// Vitest-compat shim for the legacy test-helper shape we used during
// development (pure scripts with `check(name, cond)` + `section(name)`).
//
// Lets us move existing test files into `_test/` with minimal rewrite:
//
//   import { describe, it } from "vitest";
//   import { check, section } from "./_check";
//
//   describe("…", () => {
//     it("…", () => {
//       section("group");
//       check("description", cond);
//     });
//   });

import { expect } from "vitest";

export function check(name: string, cond: boolean, info?: string): void {
  expect(cond, info ? `${name} — ${info}` : name).toBe(true);
}

export function section(_name: string): void {
  // No-op under vitest; the original logged a header.
  // Kept for source-level compatibility with existing test bodies.
}

export function approx(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) < eps;
}
