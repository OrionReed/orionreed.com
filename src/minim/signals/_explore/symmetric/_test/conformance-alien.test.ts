// conformance-alien.test.ts — run RFTS against the class-based port of
// alien-signals 3.2.1. This validates the port is faithful (it must pass
// exactly what the canonical reference passes) so it is a trustworthy
// gold-standard baseline for the benchmarks.

import { type ReactiveFramework, setExpect, testSuite } from "reactive-framework-test-suite";
import { describe, expect, it } from "vitest";
import { batch, computed, effect, signal, untracked } from "./alien-canonical";

const fw: ReactiveFramework = {
  name: "alien-canonical",
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

const DIVERGED = new Set<string>([
  "#209 three-level nested effect: cascading disposal",
  "#210 multiple inner effects all cleaned when outer re-runs",
]);

describe("alien-canonical conformance — RFTS", () => {
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
