// conformance.test.ts — RFTS (reactive-framework-test-suite) ~179
// algorithm-correctness tests against minim's signal engine.

import { describe, it, expect } from "vitest";
import { testSuite, type ReactiveFramework, setExpect } from "reactive-framework-test-suite";
import { signal, computed, effect, batch, untracked } from "@minim/signals";

const fw: ReactiveFramework = {
  name: "minim",
  signal: <T>(initial: T) => {
    const s = signal(initial);
    return {
      read: () => s.value,
      write: (v: T) => { s.value = v; },
    };
  },
  computed: <T>(fn: () => T) => {
    const c = computed(fn);
    return { read: () => c.value };
  },
  effect: (fn: () => void | (() => void)) => effect(fn),
  run: (fn: () => void) => fn(),
  batch: (fn: () => void) => batch(fn),
  untracked: <T>(fn: () => T) => untracked(fn),
};

// RFTS uses an opt-in expect impl. Vitest's `expect` is a near-perfect fit.
setExpect(<T>(actual: T) => expect(actual) as any);

describe("conformance — RFTS", () => {
  for (const section of testSuite) {
    const isBehavioral = (section as { type?: string }).type === "behavioral";
    describe(section.section, () => {
      for (const [name, fn] of Object.entries(section.cases)) {
        if (isBehavioral) {
          // Behavioral tests document divergence, not failure — skip.
          it.skip(name, () => fn(fw));
        } else {
          it(name, () => fn(fw));
        }
      }
    });
  }
});
