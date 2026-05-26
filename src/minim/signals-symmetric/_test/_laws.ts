// _laws.ts — runtime law checkers for lenses (test-only helper).
//
// Lives in `_test/` because it's only consumed by `laws.test.ts`;
// there's no production caller. The classical asymmetric-lens laws,
// adapted for our reactive setting:
//
//   GetPut : set(s, get(s)) ≈ s        (writing back what you read is a no-op)
//   PutGet : get(set(s, v)) ≈ v        (read what you just wrote)
//   PutPut : set(set(s, v₁), v₂) ≈ set(s, v₂)  (second write wins)
//
// Compliance hierarchy:
//   - very-well-behaved : all three, strict.
//   - well-behaved      : all three up to `eps`.
//   - lossy             : PutGet only (writes outside the lens's range
//                         silently clamp/snap/project).
//
// The `verify*` helpers are designed for tests: they take a thunk
// that constructs a fresh (source, lens) pair on each iteration and
// drive property tests over user-supplied generators. Per-class
// callers wire them up with the appropriate methods + arg generators.

export interface SourceAndLens<S, V> {
  /** Read or write to the underlying source (the canonical state). */
  source: { value: S; peek(): S };
  /** Read or write through the lens (the view). */
  lens: { value: V; peek(): V };
}

export interface LensLawsOpts<S, V> {
  /** Number of random trials per law. Default 50. */
  trials?: number;
  /** Equality for the *source* (post-write). Default `===`. */
  sourceEq?: (a: S, b: S) => boolean;
  /** Equality for the *view* (post-write). Default `===`. */
  viewEq?: (a: V, b: V) => boolean;
}

/** Verify GetPut: writing back what you read is a no-op on the source. */
export function verifyGetPut<S, V>(
  make: () => SourceAndLens<S, V>,
  opts: LensLawsOpts<S, V> = {},
): void {
  const trials = opts.trials ?? 50;
  const sourceEq = opts.sourceEq ?? ((a, b) => a === b);
  for (let i = 0; i < trials; i++) {
    const { source, lens } = make();
    const original = source.peek();
    const v = lens.peek();
    lens.value = v;
    if (!sourceEq(source.peek(), original)) {
      throw new Error(
        `GetPut failed: source was ${JSON.stringify(original)}, became ${JSON.stringify(source.peek())} after writing get(s)=${JSON.stringify(v)}`,
      );
    }
  }
}

/** Verify PutGet: reading after writing gives the value written. */
export function verifyPutGet<S, V>(
  make: () => SourceAndLens<S, V>,
  vGen: () => V,
  opts: LensLawsOpts<S, V> = {},
): void {
  const trials = opts.trials ?? 50;
  const viewEq = opts.viewEq ?? ((a, b) => a === b);
  for (let i = 0; i < trials; i++) {
    const { lens } = make();
    const v = vGen();
    lens.value = v;
    const read = lens.peek();
    if (!viewEq(read, v)) {
      throw new Error(
        `PutGet failed: wrote ${JSON.stringify(v)}, read back ${JSON.stringify(read)}`,
      );
    }
  }
}

/** Verify PutPut: only the last write survives. Snapshots the source
 *  before each pair of writes so both arms see the same starting state. */
export function verifyPutPut<S, V>(
  make: () => SourceAndLens<S, V>,
  vGen: () => V,
  opts: LensLawsOpts<S, V> = {},
): void {
  const trials = opts.trials ?? 50;
  const sourceEq = opts.sourceEq ?? ((a, b) => a === b);
  for (let i = 0; i < trials; i++) {
    const { source, lens } = make();
    const snapshot = source.peek();
    const v1 = vGen();
    const v2 = vGen();
    // Arm 1: write v1, then v2.
    lens.value = v1;
    lens.value = v2;
    const afterV1V2 = source.peek();
    // Reset source to snapshot. (We deep-clone where needed by writing
    // the snapshot back; structural copy via JSON for object values.)
    (source as { value: S }).value =
      typeof snapshot === "object" && snapshot !== null
        ? (JSON.parse(JSON.stringify(snapshot)) as S)
        : snapshot;
    // Arm 2: just v2.
    lens.value = v2;
    const afterV2 = source.peek();
    if (!sourceEq(afterV1V2, afterV2)) {
      throw new Error(
        `PutPut failed: after v1=${JSON.stringify(v1)} then v2=${JSON.stringify(v2)}, source=${JSON.stringify(afterV1V2)}; after only v2, source=${JSON.stringify(afterV2)}`,
      );
    }
  }
}

/** Run all three classical laws. Strict (default) or epsilon-aware
 *  via `sourceEq` / `viewEq`. */
export function verifyLensLaws<S, V>(
  make: () => SourceAndLens<S, V>,
  vGen: () => V,
  opts: LensLawsOpts<S, V> = {},
): void {
  verifyGetPut(make, opts);
  verifyPutGet(make, vGen, opts);
  verifyPutPut(make, vGen, opts);
}

/** Lossy variant: only verifies PutGet *within the lens's range*
 *  (caller controls the view generator). GetPut and PutPut may fail
 *  outside the range and aren't asserted. */
export function verifyLensLawsLossy<S, V>(
  make: () => SourceAndLens<S, V>,
  vGen: () => V,
  opts: LensLawsOpts<S, V> = {},
): void {
  verifyPutGet(make, vGen, opts);
}

// ─── Approximate equality helpers ─────────────────────────────────

/** `|a − b| < eps · max(1, |a|, |b|)` — relative-or-absolute. Suitable
 *  default for floats: handles tiny values (absolute) and large
 *  values (relative) without separate cases. */
export const approxNumber = (eps: number) => (a: number, b: number) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

/** L2-distance approx for {x, y} pairs. */
export const approxVec =
  (eps: number) => (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y) <=
    eps * Math.max(1, Math.hypot(a.x, a.y), Math.hypot(b.x, b.y));

// ─── Symmetric-lens-specific laws ──────────────────────────────────
//
// A symmetric lens carries a private complement. The classical laws
// (GetPut, PutGet, PutPut) still apply, but a few additional
// behaviours are what justify the extra machinery:
//
//   READ STABILITY  - reading n times in a row gives the same value
//                     after the complement converges (a fixpoint after
//                     at most one read), with no side effects on the
//                     source.
//
//   RECOVERY        - writing through a singular view (e.g. spread=0,
//                     scale=0, an axis with sign-flip) and then writing
//                     a non-degenerate value reproduces a meaningful
//                     state — quantified against a user-supplied
//                     baseline (what the source SHOULD look like).
//
//   CONTINUITY      - small smooth changes to the source produce small
//                     smooth changes to the view (no jitter at the
//                     gauge boundaries the complement is meant to fix).
//
//   BOUNDED WRITE   - a single write fires a single propagation round.
//                     No accumulating ping-pong from complement-driven
//                     re-entry.

/** Read N times in a row; the value returned must be identical for
 *  all reads (no observable churn from the complement). Snapshots the
 *  source to confirm it didn't move either. */
export function verifyReadStability<S, V>(
  make: () => SourceAndLens<S, V>,
  opts: LensLawsOpts<S, V> & { reads?: number } = {},
): void {
  const trials = opts.trials ?? 50;
  const reads = opts.reads ?? 5;
  const viewEq = opts.viewEq ?? ((a, b) => a === b);
  const sourceEq = opts.sourceEq ?? ((a, b) => a === b);
  for (let i = 0; i < trials; i++) {
    const { source, lens } = make();
    const beforeSrc = source.peek();
    const first = lens.peek();
    for (let k = 1; k < reads; k++) {
      const next = lens.peek();
      if (!viewEq(first, next)) {
        throw new Error(
          `read instability: read 1 was ${JSON.stringify(first)}, read ${k + 1} was ${JSON.stringify(next)}`,
        );
      }
    }
    const afterSrc = source.peek();
    if (!sourceEq(beforeSrc, afterSrc)) {
      throw new Error(
        `read had side effect on source: was ${JSON.stringify(beforeSrc)}, became ${JSON.stringify(afterSrc)}`,
      );
    }
  }
}

/** Recovery: drive the lens through a singular value and back out to a
 *  target, then compare the source against a baseline that hand-rolls
 *  the "expected" recovered shape. `singular` is the trap-triggering
 *  view value (e.g. 0 for a scale lens); `target` is what gets written
 *  after; `baseline` is what the source should look like at that
 *  target, starting from the original. */
export function verifyRecovery<S, V>(
  make: () => SourceAndLens<S, V>,
  singular: V,
  target: V,
  baseline: (originalSource: S) => S,
  opts: LensLawsOpts<S, V> & { trials?: number } = {},
): void {
  const trials = opts.trials ?? 1;
  const sourceEq = opts.sourceEq ?? ((a, b) => a === b);
  for (let i = 0; i < trials; i++) {
    const { source, lens } = make();
    // Force the lens to capture the initial state.
    lens.peek();
    const originalSrc = source.peek();
    const expected = baseline(originalSrc);
    lens.value = singular;
    lens.value = target;
    const recovered = source.peek();
    if (!sourceEq(recovered, expected)) {
      throw new Error(
        `recovery failed: after writing ${JSON.stringify(singular)} then ${JSON.stringify(target)}, source was ${JSON.stringify(recovered)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
}

/** Continuity: walk the source through a sequence of small steps and
 *  confirm the view never jumps more than `maxJump`. Surfaces sign-
 *  ambiguity jitter, polar wraps, and other gauge discontinuities. */
export function verifyContinuity<S, V>(
  make: () => SourceAndLens<S, V>,
  step: (i: number, source: SourceAndLens<S, V>["source"]) => void,
  jumpSize: (a: V, b: V) => number,
  maxJump: number,
  steps = 60,
): void {
  const { source, lens } = make();
  let prev = lens.peek();
  for (let i = 1; i <= steps; i++) {
    step(i, source);
    const next = lens.peek();
    const jump = jumpSize(prev, next);
    if (jump > maxJump) {
      throw new Error(
        `continuity failed: step ${i} jumped ${jump} (cap ${maxJump}); prev=${JSON.stringify(prev)}, next=${JSON.stringify(next)}`,
      );
    }
    prev = next;
  }
}
