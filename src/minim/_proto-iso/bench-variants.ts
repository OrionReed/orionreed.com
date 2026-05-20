// Bench the design variants in `./variants.ts` against V0 (immutable
// baseline) and the production implementation.
//
// We bench the most-affected scenarios from `bench.ts`: lens
// construction (where the allocation hit lives), reads (must stay
// identical), and writes (cross-step cost matters when invertibility
// is actually used).
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_proto-iso/bench-variants.ts

import { bench, group, do_not_optimize, run } from "mitata";
import { Signal } from "../signals/signal";

// V0 baseline
import { Chain as ChainV0, via as viaV0 } from "./iso";
// Variants
import {
  ChainV1, viaV1,
  v2, viaV2, type ChainArrV2,
  viaV3,
  ChainV4, viaV4,
  ChainV5, viaV5,
  NumChainV6,
} from "./variants";
import { Num } from "./num";

// ─── A 1-step add lens, constructed from scratch each iteration ───

const sBaseline = new Signal(0);

group("construct 1-step .add(3) lens (Num result)", () => {
  bench("V0 (immutable Chain + Wrapper)", () => {
    const c = ChainV0.of<number>().iso({
      fwd: (n: number) => n + 3, bwd: (n: number) => n - 3,
    });
    do_not_optimize(viaV0(sBaseline, c, Num));
  }).baseline(true);

  bench("V1 (mutable Chain)", () => {
    const c = ChainV1.of<number>().iso({
      fwd: (n: number) => n + 3, bwd: (n: number) => n - 3,
    });
    do_not_optimize(viaV1(sBaseline, c, Num));
  });

  bench("V2 (raw array, no Chain class)", () => {
    const c = v2.of<number>();
    v2.iso(c, { fwd: (n: number) => n + 3, bwd: (n: number) => n - 3 });
    do_not_optimize(viaV2(sBaseline, c as ChainArrV2<number, number, true>, Num));
  });

  bench("V3 (V1 chain + length-1 fast path in via)", () => {
    const c = ChainV1.of<number>().iso({
      fwd: (n: number) => n + 3, bwd: (n: number) => n - 3,
    });
    do_not_optimize(viaV3(sBaseline, c, Num));
  });

  bench("V4 (V1 + skip prev[] for arithmetic)", () => {
    const c = ChainV4.of<number>().iso({
      fwd: (n: number) => n + 3, bwd: (n: number) => n - 3,
    });
    do_not_optimize(viaV4(sBaseline, c, Num));
  });

  bench("V5 (V1+V3+V4 fused)", () => {
    const c = ChainV5.of<number>().iso({
      fwd: (n: number) => n + 3, bwd: (n: number) => n - 3,
    });
    do_not_optimize(viaV5(sBaseline, c, Num));
  });

  bench("V6 (NumChain extends Chain — single class)", () => {
    const c = NumChainV6.start().add(3);
    do_not_optimize(viaV5(sBaseline, c, Num));
  });
});

// ─── A 3-step chain, constructed from scratch each iteration ──────

group("construct 3-step chain (.add(1).scale(2).sub(3))", () => {
  bench("V0", () => {
    const c = ChainV0.of<number>()
      .iso({ fwd: (n: number) => n + 1, bwd: (n: number) => n - 1 })
      .iso({ fwd: (n: number) => n * 2, bwd: (n: number) => n / 2 })
      .iso({ fwd: (n: number) => n - 3, bwd: (n: number) => n + 3 });
    do_not_optimize(viaV0(sBaseline, c, Num));
  }).baseline(true);

  bench("V1", () => {
    const c = ChainV1.of<number>()
      .iso({ fwd: (n: number) => n + 1, bwd: (n: number) => n - 1 })
      .iso({ fwd: (n: number) => n * 2, bwd: (n: number) => n / 2 })
      .iso({ fwd: (n: number) => n - 3, bwd: (n: number) => n + 3 });
    do_not_optimize(viaV1(sBaseline, c, Num));
  });

  bench("V2", () => {
    const c = v2.of<number>();
    v2.iso(c, { fwd: (n: number) => n + 1, bwd: (n: number) => n - 1 });
    v2.iso(c, { fwd: (n: number) => n * 2, bwd: (n: number) => n / 2 });
    v2.iso(c, { fwd: (n: number) => n - 3, bwd: (n: number) => n + 3 });
    do_not_optimize(viaV2(sBaseline, c as ChainArrV2<number, number, true>, Num));
  });

  bench("V5", () => {
    const c = ChainV5.of<number>()
      .iso({ fwd: (n: number) => n + 1, bwd: (n: number) => n - 1 })
      .iso({ fwd: (n: number) => n * 2, bwd: (n: number) => n / 2 })
      .iso({ fwd: (n: number) => n - 3, bwd: (n: number) => n + 3 });
    do_not_optimize(viaV5(sBaseline, c, Num));
  });

  bench("V6 (single class, mutating)", () => {
    const c = NumChainV6.start().add(1).scale(2).sub(3);
    do_not_optimize(viaV5(sBaseline, c, Num));
  });
});

// ─── Read perf (cached) — must stay identical ─────────────────────

{
  const buildLens = <Lens>(v: (s: Signal<number>, c: unknown, Cls: typeof Num) => Lens, c: unknown) =>
    v(new Signal(0), c, Num);
  // Pre-build everything outside the bench
  const lensV0 = viaV0(new Signal(0), ChainV0.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num);
  const lensV1 = viaV1(new Signal(0), ChainV1.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;
  const c2 = v2.of<number>(); v2.iso(c2, { fwd: (n: number) => n + 3, bwd: (n: number) => n - 3 });
  const lensV2 = viaV2(new Signal(0), c2 as ChainArrV2<number, number, true>, Num) as Num;
  const lensV3 = viaV3(new Signal(0), ChainV1.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;
  const lensV4 = viaV4(new Signal(0), ChainV4.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;
  const lensV5 = viaV5(new Signal(0), ChainV5.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;

  // Warm caches
  void lensV0.value; void lensV1.value; void lensV2.value; void lensV3.value; void lensV4.value; void lensV5.value;
  void buildLens; // silence unused

  group("read cached .value (.add(3))", () => {
    bench("V0", () => do_not_optimize((lensV0 as Num).value)).baseline(true);
    bench("V1", () => do_not_optimize(lensV1.value));
    bench("V2", () => do_not_optimize(lensV2.value));
    bench("V3", () => do_not_optimize(lensV3.value));
    bench("V4", () => do_not_optimize(lensV4.value));
    bench("V5", () => do_not_optimize(lensV5.value));
  });
}

// ─── Write perf — 1-step (single-step fast path payoff) ────────────

{
  const sV0 = new Signal(0);
  const lensV0 = viaV0(sV0, ChainV0.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;
  const sV1 = new Signal(0);
  const lensV1 = viaV1(sV1, ChainV1.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;
  const sV3 = new Signal(0);
  const lensV3 = viaV3(sV3, ChainV1.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;
  const sV4 = new Signal(0);
  const lensV4 = viaV4(sV4, ChainV4.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;
  const sV5 = new Signal(0);
  const lensV5 = viaV5(sV5, ChainV5.of<number>().iso({ fwd: (n) => n + 3, bwd: (n) => n - 3 }), Num) as Num;
  let i = 0;
  group("write .value = i, 1-step lens", () => {
    bench("V0 (allocates prev[1])", () => { lensV0.value = ++i; }).baseline(true);
    bench("V1 (allocates prev[1])", () => { lensV1.value = ++i; });
    bench("V3 (single-step fast path)", () => { lensV3.value = ++i; });
    bench("V4 (skips prev for arithmetic)", () => { lensV4.value = ++i; });
    bench("V5 (fused fast path)", () => { lensV5.value = ++i; });
  });
}

// ─── Write perf — 3-step ──────────────────────────────────────────

{
  const buildV0 = () => viaV0(new Signal(0), ChainV0.of<number>()
    .iso({ fwd: (n) => n + 1, bwd: (n) => n - 1 })
    .iso({ fwd: (n) => n * 2, bwd: (n) => n / 2 })
    .iso({ fwd: (n) => n - 3, bwd: (n) => n + 3 }), Num) as Num;
  const buildV4 = () => viaV4(new Signal(0), ChainV4.of<number>()
    .iso({ fwd: (n) => n + 1, bwd: (n) => n - 1 })
    .iso({ fwd: (n) => n * 2, bwd: (n) => n / 2 })
    .iso({ fwd: (n) => n - 3, bwd: (n) => n + 3 }), Num) as Num;
  const buildV5 = () => viaV5(new Signal(0), ChainV5.of<number>()
    .iso({ fwd: (n) => n + 1, bwd: (n) => n - 1 })
    .iso({ fwd: (n) => n * 2, bwd: (n) => n / 2 })
    .iso({ fwd: (n) => n - 3, bwd: (n) => n + 3 }), Num) as Num;
  const v0 = buildV0(), v4 = buildV4(), v5 = buildV5();
  let i = 0;
  group("write .value = i, 3-step lens", () => {
    bench("V0 (allocates prev[3] every write)", () => { v0.value = ++i; }).baseline(true);
    bench("V4 (no prev alloc for arithmetic)", () => { v4.value = ++i; });
    bench("V5 (V4 + single-step path miss → multi)", () => { v5.value = ++i; });
  });
}

await run({ format: "mitata" });
