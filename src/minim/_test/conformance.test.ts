// conformance.test.ts — RFTS (reactive-framework-test-suite) ~179
// algorithm-correctness tests against minim's signal engine.

import { batch, derive, effect, cell, untracked } from "@minim/signals";
import { type ReactiveFramework, setExpect, testSuite } from "reactive-framework-test-suite";
import { describe, expect, it } from "vitest";

const fw: ReactiveFramework = {
  name: "minim",
  signal: <T>(initial: T) => {
    const s = cell(initial);
    return {
      read: () => s.value,
      write: (v: T) => {
        s.value = v;
      },
    };
  },
  computed: <T>(fn: () => T) => {
    const c = derive(fn);
    return { read: () => c.value };
  },
  effect: (fn: () => void | (() => void)) => effect(fn),
  run: (fn: () => void) => fn(),
  batch: (fn: () => void) => batch(fn),
  untracked: <T>(fn: () => T) => untracked(fn),
};

// RFTS uses an opt-in expect impl. Vitest's `expect` is a near-perfect fit.
setExpect(<T>(actual: T) => expect(actual) as any);

// Deliberate semantic divergences from RFTS. By design, minim's
// `effect()` does NOT track parent-child relationships — nested
// `effect()` calls are independent reactive scopes owned by the call
// site's returned disposer, not by an enclosing effect. This matches
// alien-signals v2, Solid 2.0's "explicit owners", Vue's `effectScope`,
// and the TC39 proposal's framework-agnostic stance. Tests that assert
// the older auto-parent-cleanup model are skipped with prejudice.
const DIVERGED = new Set<string>([
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",
]);

describe("conformance — RFTS", () => {
  for (const section of testSuite) {
    const isBehavioral = (section as { type?: string }).type === "behavioral";
    describe(section.section, () => {
      for (const [name, fn] of Object.entries(section.cases)) {
        if (isBehavioral || DIVERGED.has(name)) {
          // Behavioral tests document divergence; DIVERGED ones are
          // intentional design choices that diverge from RFTS's model.
          it.skip(name, () => fn(fw));
        } else {
          it(name, () => fn(fw));
        }
      }
    });
  }
});
