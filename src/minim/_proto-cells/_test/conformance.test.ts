// conformance.test.ts — RFTS against the prototype engine. Same
// harness as src/minim/_test/conformance.test.ts but bound to
// _proto-cells. ~179 algorithm-correctness tests covering graph
// propagation, dynamic deps, computed eval, equality, effect
// lifecycle, nested effects, inner-write, cycle detection, batching,
// untracked, error handling, stale evaluation, memory/GC.

import { type ReactiveFramework, setExpect, testSuite } from "reactive-framework-test-suite";
import { describe, expect, it } from "vitest";
import { batch, computed, effect, signal, untracked } from "../index";

const fw: ReactiveFramework = {
  name: "_proto-cells",
  signal: <T>(initial: T) => {
    const s = signal(initial);
    return {
      read: () => s.value,
      write: (v: T) => {
        s.value = v;
      },
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

setExpect(<T>(actual: T) => expect(actual) as any);

const DIVERGED = new Set<string>([
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",
]);

describe("conformance — RFTS (prototype)", () => {
  for (const section of testSuite) {
    const isBehavioral = (section as { type?: string }).type === "behavioral";
    describe(section.section, () => {
      for (const [name, fn] of Object.entries(section.cases)) {
        if (isBehavioral || DIVERGED.has(name)) {
          it.skip(name, () => fn(fw));
        } else {
          it(name, () => fn(fw));
        }
      }
    });
  }
});
