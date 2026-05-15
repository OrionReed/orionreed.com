// ── Exploration: is `cell` ALREADY just an enriched alien signal? ─────
//
// Claim under test: the current signals2 Cell<T> is, structurally and
// at runtime, an alien signal function with prototype-attached methods
// — zero wrapping, zero indirection. If true, the "alien + struct as
// one primitive" framing is already a fact; only the surface naming
// needs to make it visible.
//
// This file demonstrates the claim with three checks:
//
//   1. Identity check: is `cell(0)` actually an alien signal?
//   2. Prototype-chain check: is a typed cell's chain exactly
//      `Function.prototype ← <baseProto> ← <perTypeProto> ← instance`?
//   3. Allocation cost: does typed-cell construction add ANY allocation
//      vs bare alien `signal()`?

import { signal, isSignal } from "./engine";
import { cell, struct } from "./cell";

// ── 1. Identity ─────────────────────────────────────────────────────

const bare = cell(0);
const alien = signal(0);

console.log("── 1. Identity ──");
console.log("  cell(0) is an alien signal:    ", isSignal(bare as any));
console.log("  signal(0) is an alien signal:  ", isSignal(alien as any));
console.log("  Same construction shape:        same call, same .peek behavior");

// They're the same primitive. `cell(0)` differs only by having `.peek`
// installed as an own-property (or via prototype). The function itself
// is alien's signal callable.

// ── 2. Prototype chain ──────────────────────────────────────────────

const Vec = struct({
  name: "Vec",
  defaults: { x: 0, y: 0 } as { x: number; y: number },
  linear: { add: (a, b) => ({x:a.x+b.x, y:a.y+b.y}), sub: (a, b) => ({x:a.x-b.x, y:a.y-b.y}), scale: (a, k) => ({x:a.x*k, y:a.y*k}) },
});

const v = Vec({ x: 1, y: 2 });

console.log("\n── 2. Prototype chain ──");
let p: any = v;
let depth = 0;
while (p !== null) {
  const own = Object.getOwnPropertyNames(p);
  const sym = Object.getOwnPropertySymbols(p);
  const tag = p === Function.prototype ? "Function.prototype" :
              own.includes("add") ? `[per-type proto: ${own.length} props + ${sym.length} symbols]` :
              own.includes("peek") ? `[base proto: peek + type]` :
              `[depth ${depth}: ${own.length} props]`;
  console.log(`  ${"  ".repeat(depth)}${tag}`);
  p = Object.getPrototypeOf(p);
  depth++;
  if (depth > 6) break;  // safety
}

// Expected: v → per-type-proto (Vec's methods) → Function.prototype.
// No "Cell wrapper" object in between. v IS the alien signal callable
// with its prototype set to Vec's per-type prototype.

// ── 3. Allocation cost ──────────────────────────────────────────────
//
// If cell is just alien-signal-with-prototype, then:
//   alloc(Vec({x,y}))  ≈  alloc(signal({x,y})) + alloc(prototype-bookkeeping)
//
// The prototype is cached per-Type, so it's one-time. Per-instance
// allocation should be the same as bare alien.

console.log("\n── 3. Per-instance allocation (rough heap-delta benchmark) ──");

declare const globalThis: { gc?: () => void };
async function measure(label: string, build: () => unknown, K: number) {
  if (!globalThis.gc) { console.log(`  ${label}: --expose-gc not available`); return; }
  const pin: unknown[] = new Array(K);
  globalThis.gc();
  await new Promise(r => setTimeout(r, 5));
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < K; i++) pin[i] = build();
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  console.log(`  ${label.padEnd(34)}: ${((after - before) / K).toFixed(0).padStart(4)} b/cell`);
  if (pin.length === 0) console.log("?");
}

const K = 100_000;
await measure("alien signal(0)",       () => signal(0), K);
await measure("bare cell(0)",          () => cell(0), K);
await measure("typed Vec({x,y})",      () => Vec({ x: 1, y: 2 }), K);
await measure("alien signal({x,y})",   () => signal({ x: 1, y: 2 }), K);

console.log("\n── Interpretation ──");
console.log("  If 'typed Vec' ≈ 'alien signal({x,y})' in memory, claim holds:");
console.log("  the per-type prototype is shared, no per-instance overhead.");
console.log("  Any difference is just the {x,y} payload + prototype-slot.");

// ── 4. Surface API merger sketch ────────────────────────────────────
//
// If cells ARE alien signals, the public API could collapse:
//
//   // Today:
//   import { signal, computed, effect } from "@minim/signals2/engine";  // low-level
//   import { cell, struct, Vec } from "@minim/signals2";                // high-level
//
//   // Possible:
//   import { cell, struct, Vec } from "@minim/signals2";                // only
//   //   `cell(initial)`           → bare reactive
//   //   `cell(() => x() * 2)`     → derived  (function arg sentinel)
//   //   `cell.effect(() => ...)`  → effect
//   //   `cell.batch(() => ...)`   → batch
//   //
//   // alien primitives become implementation detail, not exported.

console.log("\n── Done ──");
