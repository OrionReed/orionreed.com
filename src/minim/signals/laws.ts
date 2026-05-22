// laws.ts — runtime law checkers for lenses.
//
// The classical asymmetric-lens laws, adapted for our reactive setting:
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
