// Retained per-node memory, minim vs alien vs preact. The forward path
// is alien verbatim, so a plain source/computed should sit near alien;
// the residual is the bireactive design (`pendingValue` for staged
// writes). Backward-only fields live off `_bwd` (see `BwdSpec`), so they
// no longer weigh on read-only nodes — a source dropped 192→128 B in the
// split. The `FatCell` mock preserves the pre-split shape as the "before"
// reference. Run:
//
//   node --expose-gc node_modules/.bin/vite-node \
//        src/minim/signals/suite/bench/memory.ts
//
// Method: allocate N live nodes, force GC, diff `heapUsed`. Reports the
// median of several trials in bytes/node. Approximate (V8 heap accounting
// is noisy) but stable enough for relative comparison — what matters is
// minim-source vs alien-signal, and the before/after delta from the split.

import { cell, derive, lens } from "@minim/signals";
import { computed as pComputed, signal as pSignal } from "@preact/signals-core";
import { computed as aComputed, signal as aSignal } from "alien-signals";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error("run with --expose-gc");
  process.exit(1);
}

const N = 200_000;
const TRIALS = 7;

function settle(): void {
  for (let i = 0; i < 5; i++) gc?.();
}

// Global sink: nodes must observably escape or V8 elides the whole
// allocation (escape analysis), reporting 0 bytes.
let SINK: unknown[] = [];

/** Median bytes/node across trials. `make(i)` returns one live node; all
 *  N are retained in an array until measured, then dropped. */
function perNode(make: (i: number) => unknown): number {
  const samples: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    SINK = [];
    settle();
    const base = process.memoryUsage().heapUsed;
    const live: unknown[] = new Array(N);
    for (let i = 0; i < N; i++) live[i] = make(i);
    SINK = live; // force escape; measured while still reachable
    settle();
    const used = process.memoryUsage().heapUsed - base;
    samples.push(used / N);
  }
  SINK = [];
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

interface Row {
  label: string;
  source: number;
  pair: number; // source + computed reading it (one realized link)
}

function row(label: string, mkSource: () => unknown, mkPair: () => unknown): Row {
  return { label, source: perNode(mkSource), pair: perNode(mkPair) };
}

const rows: Row[] = [
  row(
    "minim",
    () => cell(0),
    () => {
      const s = cell(0);
      const c = derive(() => (s.value as number) + 1);
      void c.value;
      return [s, c];
    },
  ),
  row(
    "alien",
    () => aSignal(0),
    () => {
      const s = aSignal(0);
      const c = aComputed(() => s() + 1);
      void c();
      return [s, c];
    },
  ),
  row(
    "preact",
    () => pSignal(0),
    () => {
      const s = pSignal(0);
      const c = pComputed(() => s.value + 1);
      void c.value;
      return [s, c];
    },
  ),
];

// minim-only: a 1→1 lens (carries the backward fields that justify them).
const minimLensPair = perNode(() => {
  const s = cell(0);
  const v = lens(
    s,
    (x: number) => x + 1,
    (t: number) => t - 1,
  );
  void v.value;
  return [s, v];
});

// ─── Before/after the BwdSpec split ─────────────────────────────────
//
// V8 object size is a function of field count, not behavior, so these
// field-faithful mocks pin the shapes exactly. `FatCell` mirrors the
// PRE-split `Cell` (all 20 slots in every node) — the "before". `LeanCell`
// is the shipped shape: 11 forward slots + one `_bwd` pointer, the 9
// backward fields moved into a `BwdSpec` allocated only for writable
// derived cells. Real minim source should now match `LeanCell`; a lens
// pays `LeanCell + BwdSpec`. (Whether the net is a win depends on the
// graph's source:lens ratio — leaner read-only nodes, heavier lenses.)

class FatCell {
  flags = 1;
  subs: unknown = undefined;
  subsTail: unknown = undefined;
  deps: unknown = undefined;
  depsTail: unknown = undefined;
  getter: unknown = undefined;
  _equals: unknown = Object.is;
  _watched: unknown = undefined;
  _unwatchedHook: unknown = undefined;
  currentValue: unknown;
  pendingValue: unknown;
  _bwdParent: unknown = undefined;
  _put: unknown = undefined;
  _putArity = 1;
  _fwd: unknown = undefined;
  _mergeNode: unknown = undefined;
  _complement: unknown = undefined;
  _step: unknown = undefined;
  _lastBwd: unknown = undefined;
  _queueIdx = -1;
  constructor(v: unknown) {
    this.currentValue = v;
    this.pendingValue = v;
  }
}

class LeanCell {
  flags = 1;
  subs: unknown = undefined;
  subsTail: unknown = undefined;
  deps: unknown = undefined;
  depsTail: unknown = undefined;
  getter: unknown = undefined;
  _equals: unknown = Object.is;
  _watched: unknown = undefined;
  _unwatchedHook: unknown = undefined;
  currentValue: unknown;
  pendingValue: unknown;
  _bwd: BwdSpec | undefined = undefined;
  constructor(v: unknown) {
    this.currentValue = v;
    this.pendingValue = v;
  }
}

class BwdSpec {
  _bwdParent: unknown = undefined;
  _put: unknown = undefined;
  _putArity = 1;
  _fwd: unknown = undefined;
  _mergeNode: unknown = undefined;
  _complement: unknown = undefined;
  _step: unknown = undefined;
  _lastBwd: unknown = undefined;
  _queueIdx = -1;
}

const fatSource = perNode(() => new FatCell(0));
const leanSource = perNode(() => new LeanCell(0));
const leanLensPair = perNode(() => {
  const c = new LeanCell(0);
  c._bwd = new BwdSpec();
  return c;
});

const fmt = (n: number) => n.toFixed(1).padStart(8);
console.log(`\nbytes/node (N=${N.toLocaleString()}, median of ${TRIALS})\n`);
console.log("library    source   src+computed   computed(+link)");
for (const r of rows) {
  console.log(
    `${r.label.padEnd(8)} ${fmt(r.source)}   ${fmt(r.pair)}      ${fmt(r.pair - r.source)}`,
  );
}
console.log(`\nminim source vs alien source: ${fmt(rows[0].source - rows[1].source)} bytes`);
console.log(`minim source+lens pair:       ${fmt(minimLensPair)} bytes`);

console.log(`\nbefore/after the BwdSpec split (field-faithful mocks):`);
console.log(`  FatCell mock (pre-split 20 slots):  ${fmt(fatSource)} bytes   [before]`);
console.log(`  real minim source (shipped lean):   ${fmt(rows[0].source)} bytes   [after]`);
console.log(`  LeanCell mock (11 fwd + _bwd):      ${fmt(leanSource)} bytes   [matches real]`);
console.log(`  a lens (LeanCell + BwdSpec):        ${fmt(leanLensPair)} bytes`);
console.log(`  source saving (before − after):     ${fmt(fatSource - rows[0].source)} bytes/node`);
if (SINK.length === -1) console.log(SINK); // defeat DCE of the sink
