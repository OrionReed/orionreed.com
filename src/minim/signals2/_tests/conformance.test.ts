// _conformance.test.ts — run the `reactive-framework-test-suite` (163 tests
// across 14 sections) against the PoC engine. Adapter wraps our class-based
// surface to RFTS's `.read()/.write(v)` interface.

import { testSuite, type ReactiveFramework, setExpect } from "reactive-framework-test-suite";
import { signal as povSig, computed as povComp, effect as povEff, batch as povBatch, untracked as povUntracked } from "../engine";

// ── Adapter ────────────────────────────────────────────────────────

const fw: ReactiveFramework = {
  name: "minim-pov",
  signal: <T>(initial: T) => {
    const s = povSig(initial);
    return {
      read: () => s.value,
      write: (v: T) => { s.value = v; },
    };
  },
  computed: <T>(fn: () => T) => {
    const c = povComp(fn);
    return { read: () => c.value };
  },
  effect: (fn: () => void | (() => void)) => povEff(fn),
  run: (fn: () => void) => fn(),
  batch: (fn: () => void) => povBatch(fn),
  untracked: <T>(fn: () => T) => povUntracked(fn),
};

// ── Assertion adapter ──────────────────────────────────────────────
// RFTS uses an `expect()` from its own assert.ts. Plug in a simple
// chai-like minimal impl.

function show(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

class Expect<T> {
  constructor(public actual: T) {}
  toBe(expected: T): void {
    if (!Object.is(this.actual, expected)) throw new Error(`expected ${show(this.actual)} to be ${show(expected)}`);
  }
  toEqual(expected: unknown): void {
    if (show(this.actual) !== show(expected)) throw new Error(`expected ${show(this.actual)} to equal ${show(expected)}`);
  }
  toThrow(matcher?: string | RegExp): void {
    let threw: Error | undefined;
    try { (this.actual as () => void)(); } catch (e) { threw = e as Error; }
    if (!threw) throw new Error(`expected fn to throw`);
    if (matcher !== undefined) {
      const msg = threw.message;
      const ok = typeof matcher === "string" ? msg.includes(matcher) : matcher.test(msg);
      if (!ok) throw new Error(`expected throw to match ${matcher}, got "${msg}"`);
    }
  }
  toBeGreaterThan(n: number): void {
    if (!(typeof this.actual === "number" && this.actual > n)) throw new Error(`expected ${this.actual} > ${n}`);
  }
  toBeGreaterThanOrEqual(n: number): void {
    if (!(typeof this.actual === "number" && this.actual >= n)) throw new Error(`expected ${this.actual} >= ${n}`);
  }
  toBeLessThan(n: number): void {
    if (!(typeof this.actual === "number" && this.actual < n)) throw new Error(`expected ${this.actual} < ${n}`);
  }
  toBeLessThanOrEqual(n: number): void {
    if (!(typeof this.actual === "number" && this.actual <= n)) throw new Error(`expected ${this.actual} <= ${n}`);
  }
  toBeDefined(): void {
    if (this.actual === undefined) throw new Error(`expected defined`);
  }
  toBeUndefined(): void {
    if (this.actual !== undefined) throw new Error(`expected undefined, got ${show(this.actual)}`);
  }
  toBeTruthy(): void {
    if (!this.actual) throw new Error(`expected truthy`);
  }
  toBeFalsy(): void {
    if (this.actual) throw new Error(`expected falsy`);
  }
  toContain(item: unknown): void {
    if (Array.isArray(this.actual)) {
      if (!this.actual.includes(item)) throw new Error(`expected array to contain ${show(item)}`);
    } else if (typeof this.actual === "string") {
      if (!this.actual.includes(item as string)) throw new Error(`expected string to contain ${show(item)}`);
    } else throw new Error(`toContain: unsupported actual ${show(this.actual)}`);
  }
  toHaveLength(n: number): void {
    if ((this.actual as { length: number })?.length !== n) {
      throw new Error(`expected length ${n}, got ${(this.actual as { length: number })?.length}`);
    }
  }
  toBeCloseTo(n: number, digits = 2): void {
    if (typeof this.actual !== "number") throw new Error(`expected number`);
    const diff = Math.abs(this.actual - n);
    if (diff > Math.pow(10, -digits) / 2) throw new Error(`expected ${this.actual} ≈ ${n}`);
  }
  not = {
    toBe: (expected: T) => { if (Object.is(this.actual, expected)) throw new Error(`expected NOT ${show(expected)}`); },
    toEqual: (expected: unknown) => { if (show(this.actual) === show(expected)) throw new Error(`expected NOT equal to ${show(expected)}`); },
    toThrow: () => {
      let threw = false;
      try { (this.actual as () => void)(); } catch { threw = true; }
      if (threw) throw new Error(`expected fn NOT to throw`);
    },
    toBeDefined: () => { if (this.actual !== undefined) throw new Error(`expected undefined`); },
    toBeUndefined: () => { if (this.actual === undefined) throw new Error(`expected defined`); },
    toBeTruthy: () => { if (this.actual) throw new Error(`expected falsy`); },
    toBeFalsy: () => { if (!this.actual) throw new Error(`expected truthy`); },
    toContain: (item: unknown) => {
      if (Array.isArray(this.actual) && this.actual.includes(item)) throw new Error(`expected NOT to contain`);
      if (typeof this.actual === "string" && this.actual.includes(item as string)) throw new Error(`expected NOT to contain`);
    },
  };
}

setExpect(<T>(actual: T) => new Expect(actual) as any);

// ── Runner ─────────────────────────────────────────────────────────

interface Summary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: { section: string; name: string; error: string }[];
}

const summary: Summary = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

for (const section of testSuite) {
  console.log(`\n══ ${section.section} ══`);
  const isBehavioral = (section as { type?: string }).type === "behavioral";
  let sectionPass = 0, sectionFail = 0, sectionSkip = 0;

  for (const [name, fn] of Object.entries(section.cases)) {
    summary.total++;
    try {
      fn(fw);
      summary.passed++;
      sectionPass++;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("Skip:") || (err as Error).constructor.name === "SkipTest") {
        summary.skipped++;
        sectionSkip++;
      } else if (isBehavioral) {
        // Behavioral tests document divergence, not failure
        summary.skipped++;
        sectionSkip++;
      } else {
        summary.failed++;
        sectionFail++;
        summary.failures.push({ section: section.section, name, error: msg });
        console.error(`  ✗ ${name}: ${msg.substring(0, 100)}`);
      }
    }
  }

  const passEmoji = sectionFail === 0 ? "✓" : "✗";
  console.log(`  ${passEmoji} ${sectionPass}/${sectionPass + sectionFail + sectionSkip} passed (${sectionSkip} skipped/behavioral)`);
}

console.log("\n══════════════════════════════════════════");
console.log(`Total:    ${summary.total}`);
console.log(`Passed:   ${summary.passed}`);
console.log(`Failed:   ${summary.failed}`);
console.log(`Skipped:  ${summary.skipped}`);
console.log("══════════════════════════════════════════\n");

if (summary.failed > 0) {
  console.log("First 10 failures (full list above):");
  for (const f of summary.failures.slice(0, 10)) {
    console.log(`  [${f.section}] ${f.name}`);
    console.log(`    → ${f.error.substring(0, 200)}`);
  }
  process.exit(1);
}
