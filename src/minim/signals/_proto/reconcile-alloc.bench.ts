// Hot-path representation: per-write CLOSURE vs precompiled RESOLVER.
//
// A drag loop writes one view many times per frame. The question is what each
// write allocates. We isolate the staging strategy from the rest of the engine
// and run a tight write→read loop, reporting throughput and heap growth.
//
// Run with GC visibility for the heap numbers:
//   node --expose-gc node_modules/.bin/vite-node src/minim/signals/_proto/reconcile-alloc.bench.ts
// (Throughput alone is meaningful without --expose-gc.)

const ITERS = 5_000_000;

// A minimal root whose pending is resolved on read. Two stage strategies.
type PendingClosure = { run: () => number } | undefined;
type PendingFlat = { target: number } | undefined;

// put-chain: 4 affine hops, shared & precompiled (the realistic shape).
const hops = [
  (x: number) => x - 1,
  (x: number) => x / 2,
  (x: number) => x + 3,
  (x: number) => x * 1,
];
function putChain(target: number): number {
  let t = target;
  for (let i = 0; i < hops.length; i++) t = hops[i](t);
  return t;
}

// ── Strategy A: allocate a fresh closure per write ──────────────────
class RootClosure {
  current = 0;
  pending: PendingClosure;
  write(target: number): void {
    this.pending = { run: () => putChain(target) }; // closure capturing target
  }
  read(): number {
    if (this.pending !== undefined) {
      this.current = this.pending.run();
      this.pending = undefined;
    }
    return this.current;
  }
}

// ── Strategy B: store the target; resolver is precompiled & shared ──
const resolver = putChain; // built once, reused for every write
class RootFlat {
  current = 0;
  pending: PendingFlat;
  write(target: number): void {
    this.pending = { target }; // no closure
  }
  read(): number {
    if (this.pending !== undefined) {
      this.current = resolver(this.pending.target);
      this.pending = undefined;
    }
    return this.current;
  }
}

// ── Strategy C: flat FIELDS on the root (the production target). No object
// at all per write — a kind tag + a target number, alien-`F`-flag style. ──
const K_NONE = 0;
const K_DEFER = 2;
class RootFields {
  current = 0;
  pendingKind = K_NONE;
  pendingTarget = 0;
  write(target: number): void {
    this.pendingKind = K_DEFER;
    this.pendingTarget = target; // zero allocation
  }
  read(): number {
    if (this.pendingKind !== K_NONE) {
      this.current = resolver(this.pendingTarget);
      this.pendingKind = K_NONE;
    }
    return this.current;
  }
}

function bench(label: string, run: () => void): void {
  run(); // warm
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const h0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  run();
  const ms = performance.now() - t0;
  const h1 = process.memoryUsage().heapUsed;
  const mops = (ITERS / ms / 1000).toFixed(1);
  const heap = gc ? `${((h1 - h0) / 1e6).toFixed(1)} MB retained` : "(run with --expose-gc for heap)";
  console.log(`  ${label.padEnd(26)} ${ms.toFixed(0).padStart(5)} ms   ${mops.padStart(6)} Mops/s   ${heap}`);
}

console.log(`hot write→read loop, ${(ITERS / 1e6).toFixed(0)}M iters\n`);

let sink = 0;
bench("closure per write", () => {
  const r = new RootClosure();
  for (let i = 0; i < ITERS; i++) {
    r.write(i);
    sink += r.read();
  }
});
bench("precompiled resolver", () => {
  const r = new RootFlat();
  for (let i = 0; i < ITERS; i++) {
    r.write(i);
    sink += r.read();
  }
});

// Coalesced drag: many writes, ONE read (the batched case). Closure allocates
// per write even though all but the last are discarded; flat reuses the slot.
bench("closure  (k-write/1-read)", () => {
  const r = new RootClosure();
  for (let i = 0; i < ITERS; i++) {
    r.write(i);
    if ((i & 63) === 0) sink += r.read();
  }
});
bench("flat     (k-write/1-read)", () => {
  const r = new RootFlat();
  for (let i = 0; i < ITERS; i++) {
    r.write(i);
    if ((i & 63) === 0) sink += r.read();
  }
});
bench("fields   (k-write/1-read)", () => {
  const r = new RootFields();
  for (let i = 0; i < ITERS; i++) {
    r.write(i);
    if ((i & 63) === 0) sink += r.read();
  }
});

if (sink === 12345.6789) console.log("unreachable", sink);
