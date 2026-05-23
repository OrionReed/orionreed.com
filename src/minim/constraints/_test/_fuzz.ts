// _fuzz.ts — minimal property-based testing helper.
//
// We deliberately don't pull in `fast-check`. The constraint domain is
// numeric and seeded; a tiny LCG plus a few combinators covers the
// shape of property tests we care about (random topologies, random
// pin choices, random target distances).
//
// Usage:
//   forAll(100, seed => {
//     const N = randInt(seed, 4, 16);
//     // ... build a scene ...
//     expect(invariant).toBeTruthy();
//   });

/** Linear-congruential RNG — deterministic, fast, zero-dep. Numerical
 *  properties are mediocre but fine for property tests. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    // Mix the seed so adjacent integer seeds give very different streams.
    this.state = (seed * 1664525 + 1013904223) >>> 0;
    this.state = (this.state ^ (this.state >>> 16)) >>> 0;
  }
  /** Next uniform in [0, 1). */
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  /** Float in [lo, hi). */
  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  /** Pick uniformly from `arr`. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)]!;
  }
  /** Coin flip with given probability of `true`. */
  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }
}

/** Run `body` `n` times with seeds 1..n. On failure, the seed is
 *  attached to the assertion message so reproduction is one line. */
export function forAll(n: number, body: (rng: Rng, seed: number) => void): void {
  for (let seed = 1; seed <= n; seed++) {
    try {
      body(new Rng(seed), seed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`forAll failure at seed=${seed}: ${msg}`);
    }
  }
}
