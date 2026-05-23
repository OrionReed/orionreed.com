// relate-rcm.test.ts — Reverse Cuthill-McKee bandwidth reduction.
//
// RCM is a no-op for clusters whose natural slot ordering is
// already band-minimal (chains, lattices). It earns its keep when
// users construct cells in arbitrary order and link them in
// topologies that don't match insertion order — the typical
// situation for interactive geometric construction or for
// programs that build constraint graphs incrementally.
//
// What we verify:
//   1. RCM produces an ordering whose bandwidth is no larger than
//      the natural ordering for chain-like graphs.
//   2. For shuffled-creation chains, the sparse path remains
//      reachable (bandwidth stays small) — without RCM these would
//      degenerate to dense bandwidth.
//   3. Performance on shuffled-creation chains stays close to the
//      natural-order chain perf (within constant factors).

import { describe, expect, it } from "vitest";
import { dist, pinPoint } from "../constraints";
import { vec } from "../index";
import { _clusterSparseInfo } from "../relate";

function shuffle<T>(arr: T[], seed: number): T[] {
  // Mulberry32 — deterministic shuffle so tests are reproducible.
  let s = seed | 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

describe("RCM bandwidth reduction", () => {
  it("natural-ordering chain — bandwidth is small (≤ a few)", () => {
    const N = 32;
    const pts = Array.from({ length: N }, (_, i) => vec(i, 0));
    for (let i = 1; i < N; i++) dist(pts[i - 1]!, pts[i]!, 1);
    pinPoint(pts[0]!);

    const info = _clusterSparseInfo(pts[0]! as never);
    expect(info).toBeDefined();
    // 32 vec cells × 2 slots = 64 total slots.
    expect(info!.totalSlots).toBe(64);
    // Natural ordering bandwidth for 2D chain ≈ 3.
    expect(info!.bandwidth).toBeLessThanOrEqual(4);
    // Should hit the sparse path.
    expect(info!.useSparse).toBe(true);
  });

  it("shuffled-creation chain — RCM rescues sparse-path eligibility", () => {
    // Create cells in shuffled order, then build a chain through
    // them in their *logical* (not creation) order. The natural
    // slot ordering is now scrambled — without RCM the bandwidth
    // would be O(N), forcing the dense path.
    const N = 32;
    const all = Array.from({ length: N }, (_, i) => vec(i, 0));
    const logical = shuffle(all.slice(), 0xdeadbeef);
    for (let i = 1; i < N; i++) dist(logical[i - 1]!, logical[i]!, 1);
    pinPoint(logical[0]!);

    const info = _clusterSparseInfo(logical[0]! as never);
    expect(info).toBeDefined();
    // RCM should bring bandwidth back to chain-like territory
    // (≈ 3 for a 2D chain). Without RCM it would be near N×2.
    expect(info!.bandwidth).toBeLessThan(8);
    // Sparse path stays reachable.
    expect(info!.useSparse).toBe(true);
  });

  it("shuffled chain — drag perf stays close to natural-order", () => {
    function timeChain(N: number, shuffleSeed: number | null): number {
      const all = Array.from({ length: N }, (_, i) => vec(i, 0));
      const logical = shuffleSeed === null ? all : shuffle(all.slice(), shuffleSeed);
      for (let i = 1; i < N; i++) dist(logical[i - 1]!, logical[i]!, 1);
      pinPoint(logical[0]!);
      const last = logical[N - 1]!;
      last.value = { x: N - 1, y: 0.05 };
      let dy = 0.05;
      const start = performance.now();
      for (let i = 0; i < 30; i++) {
        dy += 0.005;
        last.value = { x: N - 1, y: dy };
      }
      return (performance.now() - start) / 30;
    }
    const tNat = timeChain(64, null);
    const tShuf = timeChain(64, 0x12345678);
    console.log(
      `  N=64 chain — natural: ${tNat.toFixed(2)}ms, shuffled+RCM: ${tShuf.toFixed(2)}ms`,
    );
    // Shuffled should be within 3× of natural — RCM rescues most
    // of the cost. Without RCM it'd be 10-100× worse (dense path).
    expect(tShuf).toBeLessThan(tNat * 3 + 5);
  });

  it("star topology — RCM doesn't help (intrinsically dense)", () => {
    // Star: one hub cell with N spokes, each spoke has a dist
    // constraint to the hub. Bandwidth = N regardless of ordering;
    // RCM can't fix this. The cluster should fall through to dense.
    const N = 16;
    const hub = vec(0, 0);
    const spokes = Array.from({ length: N }, (_, i) =>
      vec(Math.cos((i * 2 * Math.PI) / N), Math.sin((i * 2 * Math.PI) / N)),
    );
    for (const s of spokes) dist(hub, s, 1);
    pinPoint(hub);

    const info = _clusterSparseInfo(hub as never);
    expect(info).toBeDefined();
    // Bandwidth is intrinsically large for a star — RCM acknowledges
    // this and returns it. The dispatch logic should pick dense.
    expect(info!.bandwidth).toBeGreaterThanOrEqual(N);
    expect(info!.useSparse).toBe(false);
  });

  it("disconnected components — RCM handles gracefully", () => {
    // Two independent chains in one cluster (would only happen
    // after relations are removed; here we simulate by ensuring
    // RCM doesn't crash on disconnected adjacency).
    // For our purposes: build two chains, then verify they form
    // separate clusters (they should). Then verify each cluster's
    // RCM info is sensible.
    const N = 16;
    const ptsA = Array.from({ length: N }, (_, i) => vec(i, 0));
    const ptsB = Array.from({ length: N }, (_, i) => vec(i, 100));
    for (let i = 1; i < N; i++) {
      dist(ptsA[i - 1]!, ptsA[i]!, 1);
      dist(ptsB[i - 1]!, ptsB[i]!, 1);
    }
    pinPoint(ptsA[0]!);
    pinPoint(ptsB[0]!);
    const a = _clusterSparseInfo(ptsA[0]! as never);
    const b = _clusterSparseInfo(ptsB[0]! as never);
    expect(a!.useSparse).toBe(true);
    expect(b!.useSparse).toBe(true);
    expect(a!.bandwidth).toBeLessThanOrEqual(4);
    expect(b!.bandwidth).toBeLessThanOrEqual(4);
  });
});
