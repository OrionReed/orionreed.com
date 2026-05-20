// RFTS conformance test for the merged Reactive prototype.
// Mirrors src/minim/_test/conformance.test.ts but uses the prototype.
//
// Run from repo root:
//   npx vitest run src/minim/_proto-reactive/conformance.test.ts

import { describe, it, expect } from "vitest";
import {
  testSuite,
  type ReactiveFramework,
  setExpect,
} from "reactive-framework-test-suite";
import {
  signal, computed, effect, batch, untracked,
} from "./reactive";

const fw: ReactiveFramework = {
  name: "minim-merged-reactive",
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

setExpect(<T>(actual: T) => expect(actual) as unknown as ReturnType<typeof expect>);

// Same intentional divergences as production minim
const DIVERGED = new Set<string>([
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",
]);

describe("conformance — RFTS (merged Reactive)", () => {
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
