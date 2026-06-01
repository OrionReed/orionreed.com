// conformance.test.ts — run the reactive-framework-test-suite (RFTS)
// against the SYMMETRIC prototype's forward engine. Forward correctness
// is the bare minimum: the prototype must pass everything the canonical
// engine does before backward semantics matter.

import { type ReactiveFramework, setExpect, testSuite } from "reactive-framework-test-suite";
import { describe, expect, it } from "vitest";
import { batch, computed, effect, signal, untracked } from "../index";

const fw: ReactiveFramework = {
  name: "minim-symmetric",
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

setExpect(<T>(actual: T) => expect(actual) as never);

// Same intentional divergences as canonical: nested `effect()` calls are
// independent reactive scopes, not auto-disposed by an enclosing effect.
const DIVERGED = new Set<string>([
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",
]);

describe("symmetric conformance — RFTS", () => {
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
