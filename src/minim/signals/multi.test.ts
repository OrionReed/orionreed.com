// multi.test.ts — combine / mean (N-to-1 lenses).
//
// Exercises the bidirectional behavior: read aggregates, write
// distributes back to all parents.
//
// Run:
//   npx vitest run src/minim/_proto-r2/multi.test.ts

import { describe, it, expect } from "vitest";
import { signal, effect } from "./signal";
import { num } from "./values/num";
import { vec } from "./values/vec";
import { box } from "./values/box";
import { combine, mean } from "./values/multi";
import { Vec } from "./values/vec";
import { Num } from "./values/num";

describe("mean()", () => {
  it("computes scalar mean reactively", () => {
    const a = num(2);
    const b = num(4);
    const c = num(6);
    const m = mean(a, b, c);
    expect(m).toBeInstanceOf(Num);
    expect(m.value).toBe(4);
    a.value = 10;
    expect(m.value).toBeCloseTo(20 / 3, 10);
  });

  it("distributes write evenly (preserves mean = new)", () => {
    const a = num(2); const b = num(4); const c = num(6);
    const m = mean(a, b, c);
    m.value = 10;     // delta = 10 - 4 = 6 per part
    expect(a.value).toBe(8);
    expect(b.value).toBe(10);
    expect(c.value).toBe(12);
    expect(m.value).toBe(10);
  });

  it("vec mean returns a Vec", () => {
    const a = vec(0, 0); const b = vec(2, 4); const c = vec(4, 8);
    const m = mean(a, b, c);
    expect(m).toBeInstanceOf(Vec);
    expect(m.value).toEqual({ x: 2, y: 4 });
    m.value = { x: 5, y: 5 };
    // Each part shifts by (5-2, 5-4) = (3, 1)
    expect(a.value).toEqual({ x: 3, y: 1 });
    expect(b.value).toEqual({ x: 5, y: 5 });
    expect(c.value).toEqual({ x: 7, y: 9 });
  });

  it("single-arg mean is identity-ish", () => {
    const a = num(7);
    const m = mean(a);
    expect(m.value).toBe(7);
    m.value = 11;
    expect(a.value).toBe(11);
  });

  it("subscribers see deduped updates", () => {
    const a = num(1); const b = num(3);
    const m = mean(a, b);
    let runs = 0;
    effect(() => { void m.value; runs++; });
    expect(runs).toBe(1);
    a.value = 1;  // no-op for Num (=== equality)
    expect(runs).toBe(1);
  });
});

describe("combine()", () => {
  it("custom merge/distribute", () => {
    // pair → tuple as JSON, parse back
    const a = num(1); const b = num(2);
    const sum = combine<number, Num>(
      [a, b],
      ([x, y]) => x + y,
      (next, [x, y]) => {
        const cur = x + y;
        const delta = next - cur;
        return [x + delta / 2, y + delta / 2];
      },
    );
    expect(sum.value).toBe(3);
    sum.value = 9;          // delta=6, half each → a=4, b=5
    expect(a.value).toBe(4);
    expect(b.value).toBe(5);
  });
});

// ─── Type-only probe ──────────────────────────────────────────────
function _typeProbe(): void {
  if (Math.random() < -1) {
    // ✓ Num has linear → mean accepts
    mean(num(1), num(2));
    // ✓ Vec has linear → mean accepts
    mean(vec(0, 0), vec(1, 1));
    // ✗ plain signal has no traits → mean rejects
    // @ts-expect-error
    mean(signal(1), signal(2));
    // ✗ Box has no metric, but we constrain `mean` on HasLinear only,
    //   and Box has linear → Box should be accepted.
    mean(box(0, 0, 1, 1), box(2, 0, 1, 1));
  }
}
void _typeProbe;
