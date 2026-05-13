// `delegate(host, key, struct)` benchmarks + correctness checks.
//
// Three flavors of a `Part`-like class, each holding a Reactive<Box>
// and exposing the Box surface (x/y/w/h, center, top, bottom, left,
// right, at, area, aabb):
//
//   DirectPart   — today's pattern. Constructor assigns
//                  `this.x = inner.x`, etc. Eagerly allocates 12
//                  lens/derived per part.
//   DelegPart    — `delegate` (cached). Prototype getters; first read
//                  installs own-property and bypasses the getter.
//   DelegLazy    — `delegateLazy` (no cache). Prototype getters
//                  always walk through.
//
// We trusted mitata to handle per-bench JIT isolation cleanly, so we
// can compare warmed-read variants in one group without the IC
// pollution we hit with the in-repo harness. The cross-process
// _isolated_check.ts sanity script is still around for spot-checks.

import { signal, type ReadonlySignal, type Signal } from "../core/signal";
import { Box, type Box as B } from "../signals/aabb";
import { delegate, delegateLazy } from "../signals/delegate";
import type { Pointlike } from "../signals/vec";
import { bench, group } from "mitata";

// ── Fixtures ───────────────────────────────────────────────────────

const seed = (): Signal<B> => signal({ x: 0, y: 0, w: 100, h: 60 });

class DirectPart {
  readonly inner: ReturnType<typeof Box.derived>;
  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
  readonly w: ReadonlySignal<number>;
  readonly h: ReadonlySignal<number>;
  readonly center: Pointlike;
  readonly top: Pointlike;
  readonly bottom: Pointlike;
  readonly left: Pointlike;
  readonly right: Pointlike;
  readonly at: (u: number, v: number) => Pointlike;
  readonly area: ReadonlySignal<number>;
  readonly aabb: ReadonlySignal<B>;
  constructor(src: ReadonlySignal<B>) {
    const b = Box.derived(() => src.value);
    this.inner = b;
    this.x = b.x; this.y = b.y; this.w = b.w; this.h = b.h;
    this.center = b.center; this.top = b.top;
    this.bottom = b.bottom; this.left = b.left; this.right = b.right;
    this.at = b.at; this.area = b.area; this.aabb = b.aabb;
  }
}

class DelegPart {
  readonly inner: ReturnType<typeof Box.derived>;
  constructor(src: ReadonlySignal<B>) {
    this.inner = Box.derived(() => src.value);
  }
}
delegate(DelegPart.prototype, "inner", Box);

class DelegLazy {
  readonly inner: ReturnType<typeof Box.derived>;
  constructor(src: ReadonlySignal<B>) {
    this.inner = Box.derived(() => src.value);
  }
}
delegateLazy(DelegLazy.prototype, "inner", Box);

// ── Correctness sanity-check (throws on mismatch at module load) ───

function assertParity(): void {
  const src = seed();
  const d = new DirectPart(src);
  const c = new DelegPart(src) as unknown as DirectPart;
  const l = new DelegLazy(src) as unknown as DirectPart;

  const probes: Array<[string, (p: DirectPart) => number]> = [
    ["x.value",                (p) => p.x.value],
    ["y.value",                (p) => p.y.value],
    ["w.value",                (p) => p.w.value],
    ["h.value",                (p) => p.h.value],
    ["center.x.value",         (p) => p.center.x.value],
    ["center.y.value",         (p) => p.center.y.value],
    ["top.x.value",            (p) => p.top.x.value],
    ["right.y.value",          (p) => p.right.y.value],
    ["at(0.25, 0.75).x.value", (p) => p.at(0.25, 0.75).x.value],
    ["area.value",             (p) => p.area.value],
    ["aabb.x.value",           (p) => p.aabb.x.value],
  ];

  for (const [label, read] of probes) {
    const ref = read(d);
    for (const [name, inst] of [["delegate", c], ["delegateLazy", l]] as const) {
      const got = read(inst);
      if (got !== ref) {
        throw new Error(
          `delegate parity broken: ${name}.${label} = ${got} vs direct = ${ref}`,
        );
      }
    }
  }

  src.value = { x: 10, y: 20, w: 200, h: 80 };
  for (const [name, inst] of [
    ["direct", d],
    ["delegate", c],
    ["delegateLazy", l],
  ] as const) {
    if (inst.x.value !== 10 || inst.w.value !== 200) {
      throw new Error(`delegate reactivity broken: ${name}`);
    }
  }
}

assertParity();

// ── Suites ─────────────────────────────────────────────────────────

group("delegate: construction (per-instance cost)", () => {
  const src = seed();
  bench("Direct (12 field assigns)", () => new DirectPart(src)).baseline(true);
  bench("delegate", () => new DelegPart(src));
  bench("delegateLazy", () => new DelegLazy(src));
});

group("delegate: first axis read on a fresh part", () => {
  const src = seed();
  bench("Direct: new + p.x.value", () =>
    new DirectPart(src).x.value,
  ).baseline(true);
  bench("delegate: new + p.x.value", () =>
    (new DelegPart(src) as any).x.value,
  );
  bench("delegateLazy: new + p.x.value", () =>
    (new DelegLazy(src) as any).x.value,
  );
});

group("delegate: first lazy-getter read on a fresh part", () => {
  const src = seed();
  bench("Direct: new + p.center.x.value", () =>
    new DirectPart(src).center.x.value,
  ).baseline(true);
  bench("delegate: new + p.center.x.value", () =>
    (new DelegPart(src) as any).center.x.value,
  );
  bench("delegateLazy: new + p.center.x.value", () =>
    (new DelegLazy(src) as any).center.x.value,
  );
});

group("delegate: warmed pipeline — `.x.value`", () => {
  const src = seed();
  const d = new DirectPart(src);
  const c = new DelegPart(src) as unknown as DirectPart;
  const l = new DelegLazy(src) as unknown as DirectPart;
  void d.x; void c.x; void l.x;
  bench("Direct", () => d.x.value).baseline(true);
  bench("delegate", () => c.x.value);
  bench("delegateLazy", () => l.x.value);
});

group("delegate: warmed lazy getter — `.center.x.value`", () => {
  const src = seed();
  const d = new DirectPart(src);
  const c = new DelegPart(src) as unknown as DirectPart;
  const l = new DelegLazy(src) as unknown as DirectPart;
  void d.center.x; void c.center.x; void l.center.x;
  bench("Direct", () => d.center.x.value).baseline(true);
  bench("delegate", () => c.center.x.value);
  bench("delegateLazy", () => l.center.x.value);
});

group("delegate: mixed multi-property pattern (realistic effect read)", () => {
  const src = seed();
  const d = new DirectPart(src);
  const c = new DelegPart(src) as unknown as DirectPart;
  const l = new DelegLazy(src) as unknown as DirectPart;
  void d.x; void d.y; void d.w; void d.h; void d.center.x;
  void c.x; void c.y; void c.w; void c.h; void c.center.x;
  void l.x; void l.y; void l.w; void l.h; void l.center.x;
  bench("Direct: 4 axes + center.x + center.y", () =>
    d.x.value + d.y.value + d.center.x.value + d.center.y.value,
  ).baseline(true);
  bench("delegate", () =>
    c.x.value + c.y.value + c.center.x.value + c.center.y.value,
  );
  bench("delegateLazy", () =>
    l.x.value + l.y.value + l.center.x.value + l.center.y.value,
  );
});
