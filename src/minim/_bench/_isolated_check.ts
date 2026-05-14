// Standalone V8 sanity check: build ONE part flavor, do hot-loop
// reads, time it. No cross-class IC training, no harness, no other
// suites running. Run each variant separately by editing VARIANT.

import { signal } from "@minim/signals";
import {
  Box,
  delegate,
  delegateLazy,
  type Box as B,
} from "@minim/values";

const ITERS = 30_000_000;

function bench(label: string, target: string, run: () => number): void {
  // Warmup.
  let s = 0;
  for (let i = 0; i < 1_000_000; i++) s ^= run() | 0;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERS; i++) s ^= run() | 0;
  const t1 = process.hrtime.bigint();

  const ns = Number(t1 - t0) / ITERS;
  console.log(`${label.padEnd(8)} ${target.padEnd(18)} ${ns.toFixed(2).padStart(7)}ns/op   sink=${s}`);
}

class DirectPart {
  readonly inner: any;
  readonly x: any; readonly y: any; readonly w: any; readonly h: any;
  readonly center: any;
  constructor(src: any) {
    const b = Box.derived(() => src.value);
    this.inner = b;
    this.x = b.x;
    this.y = b.y;
    this.w = b.w;
    this.h = b.h;
    this.center = b.center;
  }
}

class DelegPart {
  readonly inner: any;
  constructor(src: any) {
    this.inner = Box.derived(() => src.value);
  }
}
delegate(DelegPart.prototype, "inner", Box);

class LazyPart {
  readonly inner: any;
  constructor(src: any) {
    this.inner = Box.derived(() => src.value);
  }
}
delegateLazy(LazyPart.prototype, "inner", Box);

const src = signal<B>({ x: 0, y: 0, w: 100, h: 60 });

const VARIANT = process.argv[2] ?? "direct";
const TARGET = process.argv[3] ?? "x.value";

const make = (() => {
  switch (VARIANT) {
    case "direct":   return new DirectPart(src);
    case "delegate": return new DelegPart(src);
    case "lazy":     return new LazyPart(src);
    default: throw new Error(`unknown variant: ${VARIANT}`);
  }
})() as any;

void make.x; void make.y; void make.w; void make.h;  // warm axes
void make.center;  // warm lazy getter

const fns: Record<string, () => number> = {
  "x.value":         () => make.x.value,
  "center.x.value":  () => make.center.x.value,
  // Realistic pattern: read multiple properties per iter, like an
  // effect computing a layout. Sums xywh + center.x + center.y.
  "mixed":           () => {
    return (
      make.x.value + make.y.value +
      make.center.x.value + make.center.y.value
    );
  },
};

const fn = fns[TARGET];
if (!fn) {
  console.error(`unknown target: ${TARGET}; use one of ${Object.keys(fns).join(", ")}`);
  process.exit(1);
}
bench(VARIANT, TARGET, fn);
