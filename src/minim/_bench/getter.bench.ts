import { Vec } from "../signals/vec";
import { Box } from "../signals/aabb";
import { bench, suite } from "./harness";

// ── Lazy getter: first-access (build) cost vs cached (own-property) ─

suite("lazy getter — Box.center", () => {
  // First-access: each iter constructs a fresh Box and touches .center.
  // Measures the build cost (Vec.derived + defineProperty).
  bench("first .center access (build cost)", () => {
    const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
    return b.center;
  });

  // Cached access: own-property fast path.
  const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
  void b.center;
  bench("cached .center (own-property)", () => b.center);
});

suite("lazy getter — Box.area + Vec.length (scalar getters)", () => {
  bench("first .area access (build cost)", () => {
    const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
    return b.area;
  });
  const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
  void b.area;
  bench("cached .area (own-property)", () => b.area);

  bench("first .length access (build cost)", () => {
    const v: any = Vec.signal({ x: 3, y: 4 });
    return v.length;
  });
  const v: any = Vec.signal({ x: 3, y: 4 });
  void v.length;
  bench("cached .length (own-property)", () => v.length);
});

suite("lazy getter — read .value through the getter", () => {
  // The whole-pipeline cost: cached getter → .value read → computed eval.
  const b: any = Box.signal({ x: 0, y: 0, w: 10, h: 10 });
  void b.area;
  bench("Box.area.value (cached + read)", () => b.area.value);

  const v: any = Vec.signal({ x: 3, y: 4 });
  void v.length;
  bench("Vec.length.value (cached + read)", () => v.length.value);
});
