import { Vec } from "../signals/vec";
import { Box } from "../signals/box";
import { bench, do_not_optimize, group } from "mitata";

// ── Lazy getter: first-access (build) cost vs cached (own-property) ─

group("lazy getter — Box.center", () => {
  // First-access: each iter constructs a fresh Box and touches .center.
  // Measures the build cost (Vec.derived + defineProperty).
  bench("first .center access (build cost)", () => {
    const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
    return b.center;
  }).baseline(true);

  // Cached access: own-property fast path. `do_not_optimize` keeps V8
  // from eliminating the access — without it the bench would measure
  // ~0ns because `b.center` is provably loop-invariant.
  const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
  void b.center;
  bench("cached .center (own-property)", () => {
    do_not_optimize(b.center);
  });
});

group("lazy getter — Box.area + Vec.length (scalar getters)", () => {
  bench("first .area access (build cost)", () => {
    const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
    return b.area;
  }).baseline(true);
  const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
  void b.area;
  bench("cached .area (own-property)", () => {
    do_not_optimize(b.area);
  });

  bench("first .length access (build cost)", () => {
    const v: any = Vec.signal({ x: 3, y: 4 });
    return v.length;
  });
  const v: any = Vec.signal({ x: 3, y: 4 });
  void v.length;
  bench("cached .length (own-property)", () => {
    do_not_optimize(v.length);
  });
});

group("lazy getter — read .value through the getter", () => {
  // The whole-pipeline cost: cached getter → .value read → computed eval.
  const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
  void b.area;
  bench("Box.area.value (cached + read)", () => b.area.value).baseline(true);

  const v: any = Vec.signal({ x: 3, y: 4 });
  void v.length;
  bench("Vec.length.value (cached + read)", () => v.length.value);
});
