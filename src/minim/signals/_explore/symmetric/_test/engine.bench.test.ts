// engine.bench.test.ts — head-to-head against the GOLD STANDARD
// (class-based alien-signals 3.2.1 port in ./alien-canonical). Alien is
// forward-only, so it sets the floor for every forward shape; the
// symmetric engine must match it. The backward-only shapes (merge /
// fan-in / field) have no alien equivalent and are measured solo.
//
// `timed` reports min-of-N ns/op (robust microbench estimator).

import { describe, it } from "vitest";
import * as alien from "./alien-canonical";
import * as sym from "../index";
import type { Vec } from "../values/vec";
import { polar, vec } from "../values/vec";

const N = 50_000;

function timed(label: string, fn: () => void): number {
  for (let w = 0; w < 5; w++) fn();
  let ms = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 8; r++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    if (t1 - t0 < ms) ms = t1 - t0;
  }
  console.info(
    `  ${label.padEnd(60)}  ${ms.toFixed(2).padStart(8)}ms  ${((ms * 1e6) / N).toFixed(0).padStart(4)} ns/op`,
  );
  return ms;
}

// ─── FWD parity: alien (gold) vs symmetric ────────────────────────

describe("FWD: bare signal write, no subscribers", () => {
  it("ALIEN", () => {
    const s = alien.signal(0);
    timed("alien      signal write (no subs) ×N", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
  });
  it("SYMMETRIC", () => {
    const s = sym.signal(0);
    timed("symmetric  signal write (no subs) ×N", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
  });
});

describe("FWD: signal write → 1 effect (propagation)", () => {
  it("ALIEN", () => {
    const s = alien.signal(0);
    let sink = 0;
    alien.effect(() => {
      sink += s.value;
    });
    timed("alien      write→effect ×N", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
    void sink;
  });
  it("SYMMETRIC", () => {
    const s = sym.signal(0);
    let sink = 0;
    sym.effect(() => {
      sink += s.value;
    });
    timed("symmetric  write→effect ×N", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
    void sink;
  });
});

describe("FWD: 5-deep computed chain (write root, read tip)", () => {
  it("ALIEN", () => {
    const root = alien.signal(0);
    let c: { value: number } = root;
    for (let i = 0; i < 5; i++) {
      const p = c;
      c = alien.computed(() => p.value + 1);
    }
    void c.value;
    timed("alien      computed-chain ×N", () => {
      for (let i = 0; i < N; i++) {
        root.value = i;
        void c.value;
      }
    });
  });
  it("SYMMETRIC", () => {
    const root = sym.signal(0);
    let c: sym.Signal<number> = root;
    for (let i = 0; i < 5; i++) {
      const p = c;
      c = sym.computed(() => p.value + 1);
    }
    void c.value;
    timed("symmetric  computed-chain ×N", () => {
      for (let i = 0; i < N; i++) {
        root.value = i;
        void c.value;
      }
    });
  });
});

describe("FWD: wide fan-out (1 source → 16 computeds → 1 effect)", () => {
  const W = 16;
  it("ALIEN", () => {
    const root = alien.signal(0);
    const cs = Array.from({ length: W }, (_, k) => alien.computed(() => root.value + k));
    let sink = 0;
    alien.effect(() => {
      for (const c of cs) sink += c.value;
    });
    timed("alien      wide fan-out ×N", () => {
      for (let i = 0; i < N; i++) root.value = i;
    });
    void sink;
  });
  it("SYMMETRIC", () => {
    const root = sym.signal(0);
    const cs = Array.from({ length: W }, (_, k) => sym.computed(() => root.value + k));
    let sink = 0;
    sym.effect(() => {
      for (const c of cs) sink += c.value;
    });
    timed("symmetric  wide fan-out ×N", () => {
      for (let i = 0; i < N; i++) root.value = i;
    });
    void sink;
  });
});

describe("FWD: diamond (source → a,b → join → effect)", () => {
  it("ALIEN", () => {
    const root = alien.signal(0);
    const a = alien.computed(() => root.value + 1);
    const b = alien.computed(() => root.value - 1);
    const join = alien.computed(() => a.value + b.value);
    let sink = 0;
    alien.effect(() => {
      sink += join.value;
    });
    timed("alien      diamond ×N", () => {
      for (let i = 0; i < N; i++) root.value = i;
    });
    void sink;
  });
  it("SYMMETRIC", () => {
    const root = sym.signal(0);
    const a = sym.computed(() => root.value + 1);
    const b = sym.computed(() => root.value - 1);
    const join = sym.computed(() => a.value + b.value);
    let sink = 0;
    sym.effect(() => {
      sink += join.value;
    });
    timed("symmetric  diamond ×N", () => {
      for (let i = 0; i < N; i++) root.value = i;
    });
    void sink;
  });
});

// ─── BWD-only shapes (no alien equivalent) ────────────────────────

describe("BWD: merge fold, 4 contributors, batched write", () => {
  it("SYMMETRIC", () => {
    const root = sym.signal(0);
    const m = root.merge(sym.sumPolicy);
    const arms = Array.from({ length: 4 }, () =>
      sym.lens(
        m,
        (v) => v,
        (t) => t,
      ),
    );
    void root.value;
    timed("symmetric  merge 4-contrib batched ×N/4", () => {
      for (let i = 0; i < N / 4; i++) {
        sym.batch(() => {
          for (const a of arms) a.value = i;
        });
      }
    });
  });
});

describe("BWD: fan-in (axes) write-split", () => {
  it("SYMMETRIC", () => {
    const p = vec(0, 0) as unknown as Vec;
    timed("symmetric  vec axes write-split ×N", () => {
      for (let i = 0; i < N; i++) {
        (p as { value: { x: number; y: number } }).value = { x: i, y: i + 1 };
      }
    });
  });
});

describe("BWD: field lens round-trip (vec.x write)", () => {
  it("SYMMETRIC", () => {
    const p = vec(0, 0);
    const x = p.x;
    void x.value;
    timed("symmetric  vec.x field write ×N", () => {
      for (let i = 0; i < N; i++) {
        (x as { value: number }).value = i;
      }
    });
  });
});

describe("BWD: explicit multi-parent (2 parents), GENUINE writes — equality-check overhead", () => {
  it("SYMMETRIC scalar view (Object.is compare)", () => {
    const a = sym.signal(0);
    const b = sym.signal(0);
    const v = sym.iso(
      [a, b],
      (vals) => (vals[0] as number) + (vals[1] as number),
      (t) => [(t as number) / 2, (t as number) / 2],
    );
    void v.value;
    timed("symmetric  multi-parent scalar genuine-write ×N", () => {
      for (let i = 0; i < N; i++) {
        (v as { value: number }).value = i; // always changes ⇒ never absorbed
      }
    });
  });
  it("SYMMETRIC object view (Object.is compare, never absorbs)", () => {
    const a = sym.signal(0);
    const b = sym.signal(0);
    const v = sym.iso(
      [a, b],
      (vals) => ({ x: vals[0] as number, y: vals[1] as number }),
      (t) => [(t as { x: number }).x, (t as { y: number }).y],
    );
    void v.value;
    timed("symmetric  multi-parent object genuine-write ×N", () => {
      for (let i = 0; i < N; i++) {
        (v as { value: { x: number; y: number } }).value = { x: i, y: i + 1 };
      }
    });
  });
});

describe("BWD: polar drag (3-parent, trig fwd) — equality-check worst case", () => {
  it("SYMMETRIC", () => {
    const p = polar(vec(0, 0), 5, 0, "rotate");
    void p.value;
    timed("symmetric  polar rotate drag ×N", () => {
      for (let i = 0; i < N; i++) {
        (p as { value: { x: number; y: number } }).value = { x: i % 7, y: (i % 5) + 1 };
      }
    });
  });
});

describe("BWD: deep identity lens chain write (10-deep)", () => {
  it("SYMMETRIC", () => {
    const root = sym.signal(0);
    let c: sym.Signal<number> = root;
    for (let i = 0; i < 10; i++) {
      c = sym.lens(
        c,
        (v) => v,
        (t) => t,
      );
    }
    void c.value;
    timed("symmetric  10-deep bwd write ×N", () => {
      for (let i = 0; i < N; i++) {
        c.value = i;
      }
    });
  });
});
