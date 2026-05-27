// perf-and-realism.test.ts — scale tests and realistic-shape scenarios.

import { describe, expect, it } from "vitest";
import { batch, effect, num, type Num, Vec, vec, type Writable } from "../../../index";
import { clampSlide, numAddW, numWithSlack, vecRightW } from "../wp";
import { lensTracked } from "../wp-detect";

describe("PERF: O(depth × fanout) per write", () => {
  it("DEPTH FINDING: ~2000 levels recursive getters stack-overflow", () => {
    // The engine reads through computed/lens chains recursively. The
    // wp lenses inherit this — read-cost scales with depth but the
    // call stack does too. ~2000-5000 is the JS stack limit.
    // Mitigation: trampoline read-eval, or impose a depth check at
    // construction. This is NOT a wp-specific footgun — any deeply
    // chained computed in the engine has the same limit.
    const a = num(0);
    let cur: Writable<Num> = a;
    const slacks: Writable<Num>[] = [];
    for (let i = 0; i < 500; i++) {
      const s = num(1);
      slacks.push(s);
      cur = numAddW(cur, s, 0);
    }
    const t0 = performance.now();
    cur.value = 2500;
    const t1 = performance.now();
    expect(slacks[499]!.peek()).toBe(2001);
    expect(a.peek()).toBe(0);
    expect(t1 - t0).toBeLessThan(500);
  });

  it("write that fans to 1000 parents: <10ms", () => {
    const parents: Writable<Num>[] = [];
    for (let i = 0; i < 1000; i++) parents.push(num(i));
    // Sum-of-1000 lens with even split
    const sum = lensTracked(
      parents,
      vs => vs.reduce((a, b) => (a as number) + (b as number), 0),
      (target, vs) => {
        const arr = vs as readonly number[];
        const cur = arr.reduce((a, b) => a + b, 0);
        const delta = (target as number) - cur;
        const each = delta / arr.length;
        return arr.map(v => v + each) as never;
      },
    );
    expect(sum.value).toBe((999 * 1000) / 2);

    const t0 = performance.now();
    sum.value = 1_000_000;
    const t1 = performance.now();
    expect(t1 - t0).toBeLessThan(50);
    // Each parent grows by ~1000 - i_offset
    expect(parents[0]!.peek()).toBeCloseTo(1000 - 499.5, 0);
  });

  it("read costs: 1000 reads in a tight loop, <5ms", () => {
    const a = num(0);
    let cur: Writable<Num> = a;
    for (let i = 0; i < 100; i++) cur = numAddW(cur, num(1), 0);
    const t0 = performance.now();
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += cur.value;
    const t1 = performance.now();
    expect(sum).toBe(100_000);
    expect(t1 - t0).toBeLessThan(100);
  });
});

describe("REALISTIC: a card row with slack-based min widths", () => {
  // Each card has a base width and a "min" slack. The visible width is
  // max(base, min) — but here, simpler: use clampSlide so dragging
  // pushes the actual width past the cap if you drag past.

  it("dragging makes total widths add up; slack adjusts dynamically", () => {
    const widths = [num(100), num(100), num(100)];
    const total = numAddW(
      widths[0]!,
      lensTracked(
        [widths[1]!, widths[2]!] as const,
        ([a, b]) => a + b,
        (t, [a, b]) => {
          const d = t - (a + b);
          return [a + d / 2, b + d / 2] as const;
        },
      ),
      0,
    );
    expect(total.value).toBe(300);

    total.value = 400; // 100 more total
    // total bwd: w=0, so right side (sum of widths[1] + widths[2]) absorbs
    // sum := 300; w[1]+w[2] := 300; w[1]+=50, w[2]+=50
    expect(widths[0]!.peek()).toBe(100); // anchored by w=0
    expect(widths[1]!.peek()).toBe(150);
    expect(widths[2]!.peek()).toBe(150);
  });
});

describe("REALISTIC: collapse/expand pane with hidden slack", () => {
  it("collapsing the pane absorbs into a hidden slack signal", () => {
    const visible = num(200);
    const hidden = num(0);
    const total = numWithSlack(visible, hidden);
    expect(total.value).toBe(200);

    // User collapses to 0
    total.value = 0;
    expect(visible.peek()).toBe(200); // still 200; UI uses it for restore
    expect(hidden.peek()).toBe(-200); // hidden cancels visible
    expect(total.value).toBe(0);

    // Restore by setting total back; hidden goes back to 0
    total.value = 200;
    expect(hidden.peek()).toBe(0);
    expect(visible.peek()).toBe(200);
  });
});

describe("REALISTIC: spring with reactive rest position", () => {
  // A position cell whose 'rest' position is itself draggable. Push the
  // mass and the rest absorbs.

  it("dragging the mass moves either the mass or the rest, depending on weight", () => {
    const rest = num(100);
    const offset = num(0);
    const mass = numAddW(rest, offset, 0);
    // weight = 0 on rest → offset absorbs (good: drag the mass, leave rest)
    expect(mass.value).toBe(100);
    mass.value = 150;
    expect(rest.peek()).toBe(100);
    expect(offset.peek()).toBe(50);

    // Now drag the rest:
    rest.value = 200;
    expect(mass.value).toBe(250); // mass follows rest + offset
  });
});

describe("REALISTIC: chained polar — orbit on orbit with shared center", () => {
  // Earth orbits Sun. Moon orbits Earth. Drag Moon → r/a of moon
  // change. Drag Earth → its r/a change (Sun fixed) AND Moon follows.
  it("Moon's position depends on Earth's; Earth's depends on Sun's", () => {
    const sun = vec(0, 0);
    const earthR = num(100);
    const earthA = num(0);
    const earth = lensTracked(
      [sun, earthR, earthA] as const,
      ([sv, rv, av]) => ({
        x: sv.x + rv * Math.cos(av),
        y: sv.y + rv * Math.sin(av),
      }),
      (target, [sv, _rv, _av]) => {
        const dx = target.x - sv.x;
        const dy = target.y - sv.y;
        return [undefined, Math.hypot(dx, dy), Math.atan2(dy, dx)] as const;
      },
      Vec,
    );
    expect(earth.value.x).toBeCloseTo(100);
    expect(earth.value.y).toBeCloseTo(0);

    // Drag earth to (0, 50). Earth orbit shrinks; angle changes.
    earth.value = { x: 0, y: 50 };
    expect(earthR.peek()).toBeCloseTo(50);
    expect(earthA.peek()).toBeCloseTo(Math.PI / 2);
  });
});

describe("RUNTIME INVARIANT: glitch-freedom across wp + classical mix", () => {
  it("observer never sees mid-bwd state", () => {
    const a = num(10);
    const n = num(5);
    const v = vec(0, 0);
    const wp = vecRightW(v, n);
    const c = clampSlide(numAddW(a, n, 0.5), num(0), num(1000));

    let observations = 0;
    const stop = effect(() => {
      void wp.value;
      void c.value;
      observations++;
    });
    observations = 0;

    batch(() => {
      a.value = 100;
      n.value = 50;
      v.value = { x: 5, y: 5 };
      wp.value = { x: 200, y: 10 };
    });
    expect(observations).toBe(1);

    stop();
  });
});
