// mix.ts — static N→1 aggregation with first-class composable merges
// and writebacks.
//
//   mix(Cls, parts, merge)             — RO  value-class lens (read merges parts)
//   mix(Cls, parts, merge, writeback)  — RW  value-class lens (writes distribute)
//
// The shape of the lens is fixed at construction: `parts` is a static
// list of reactive contributors (with optional reactive weights).
// Membership doesn't change after construction. If you need dynamic
// membership, build a fresh mix when the set changes.
//
// Merges and writebacks are first-class function values, so they
// compose: `top(3, mean)`, `above(0.1, deltaEven)`. Stock merges
// (`mean`, `sum`, `priority`, `latest`, `firstNonNull`, `min`, `max`)
// and stock writebacks (`deltaEven`, `replaceFirst`, `proportional`)
// cover the common cases.
//
// What this subsumes from earlier designs:
//   - combine(parts, merge, distribute)   → mix(Cls, parts, merge, writeback)
//   - mean(...sigs)                       → mix(Cls, sigs, mean, deltaEven)
//   - the older mutable-membership mix    → (gone; rebuild on membership change)
//
// What stays specialised:
//   - polar/argmin*/hyperLens — heterogeneous inputs and/or numerical
//     writebacks. mix's generality would pay 2-3× allocation cost; the
//     hand-tuned versions earn their existence.
//
// Perf trick: the `Contribution[]` array AND the per-contribution
// records are pre-allocated at construction and mutated in place on
// each read/write. Compared to a fresh-allocation approach (what
// the older `combine` and the prototype `mix` did) this is ~14%
// faster on writes; reads are at parity.

import { computed, type Read, Signal, signal, type Val, valFn } from "./signal";
import { type Linear, type TraitDict } from "./traits";
import { type Writable } from "./writable";

// ─── Public types ────────────────────────────────────────────────────

/** A contributor passed to `mix`. Bare `Val<T>` is shorthand for
 *  `{ src: val, weight: 1 }`; the record form lets you supply a
 *  reactive weight. */
export type Part<T> = Val<T> | { src: Val<T>; weight?: Val<number> };

/** Snapshot of one contributor at evaluation time. */
export interface Contribution<T> {
  readonly value: T;
  readonly weight: number;
}

/** A merge: two-stage. `Merge<T>` is a *factory* — given the value
 *  class's traits, it returns a `(parts) => T` ready to run on every
 *  evaluation. Trait-needing merges (`mean`, `sum`) resolve their
 *  trait dependency in the outer stage and capture the impl in the
 *  closure; trait-free merges (`priority`, `latest`) ignore traits
 *  and just `return (parts) => …`.
 *
 *  Two-stage so `mix` calls `merge(traits)` ONCE at construction.
 *  Per-evaluation calls hit only the inner closure with `lin` (or
 *  similar) already captured — no `traits.linear` lookup, no
 *  `needLinear` check. In practice V8 inlines the legacy form so
 *  well that the runtime delta is in the noise; the win is in
 *  intent and composability (combinators thread traits through, not
 *  shuttle them through every call).
 *
 *  Default `T = any` so built-in merge values are assignable to
 *  `Merge<V>` for any concrete `V`, sidestepping `TraitDict<T>`'s
 *  invariance. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape for built-ins
export type Merge<T = any> = (traits: TraitDict<T>) => (parts: readonly Contribution<T>[]) => T;

/** A writeback: two-stage, dual to `Merge`. `Writeback<T>` is a
 *  factory — given the class's traits, returns a
 *  `(next, parts) => T[]` ready to run on every write. Length-
 *  mismatch on the returned array throws at write time.
 *
 *  Same `T = any` default and two-stage rationale as `Merge<T>`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape for built-ins
export type Writeback<T = any> = (
  traits: TraitDict<T>,
) => (next: T, parts: readonly Contribution<T>[]) => readonly T[];

// ─── Built-in merges ────────────────────────────────────────────────

/** Weighted mean, normalised by total weight. Equal-weight mean is
 *  the special case where every contributor was added without a
 *  weight (defaulting to 1). Requires the `linear` trait. */
export const mean: Merge = traits => {
  const lin = needLinear(traits as TraitDict<unknown>, "mean");
  return parts => {
    if (parts.length === 0) throw new Error("mix(mean): no contributors");
    let acc = lin.scale(parts[0]!.value, parts[0]!.weight);
    let total = parts[0]!.weight;
    for (let i = 1; i < parts.length; i++) {
      acc = lin.add(acc, lin.scale(parts[i]!.value, parts[i]!.weight));
      total += parts[i]!.weight;
    }
    return total === 0 ? parts[0]!.value : lin.scale(acc, 1 / total);
  };
};

/** Weighted sum (no normalisation). Requires the `linear` trait. */
export const sum: Merge = traits => {
  const lin = needLinear(traits as TraitDict<unknown>, "sum");
  return parts => {
    if (parts.length === 0) throw new Error("mix(sum): no contributors");
    let acc = lin.scale(parts[0]!.value, parts[0]!.weight);
    for (let i = 1; i < parts.length; i++) {
      acc = lin.add(acc, lin.scale(parts[i]!.value, parts[i]!.weight));
    }
    return acc;
  };
};

/** Highest-weight contributor wins. Ties resolved by index order.
 *  Trait-free. */
export const priority: Merge = () => parts => {
  if (parts.length === 0) throw new Error("mix(priority): no contributors");
  let best = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]!.weight > best.weight) best = parts[i]!;
  }
  return best.value;
};

/** Last contributor (in index order) wins. Trait-free. */
export const latest: Merge = () => parts => {
  if (parts.length === 0) throw new Error("mix(latest): no contributors");
  return parts[parts.length - 1]!.value;
};

/** First non-null contribution wins. Useful for default/fallback chains. */
export const firstNonNull: Merge = () => parts => {
  for (const p of parts) if (p.value != null) return p.value;
  if (parts.length === 0) throw new Error("mix(firstNonNull): no contributors");
  return parts[0]!.value;
};

/** Numeric minimum across contributors. Trait-free. */
export const min: Merge<number> = () => parts => {
  if (parts.length === 0) throw new Error("mix(min): no contributors");
  let m = parts[0]!.value;
  for (let i = 1; i < parts.length; i++) if (parts[i]!.value < m) m = parts[i]!.value;
  return m;
};

/** Numeric maximum across contributors. Trait-free. */
export const max: Merge<number> = () => parts => {
  if (parts.length === 0) throw new Error("mix(max): no contributors");
  let m = parts[0]!.value;
  for (let i = 1; i < parts.length; i++) if (parts[i]!.value > m) m = parts[i]!.value;
  return m;
};

// ─── Built-in writebacks ────────────────────────────────────────────

/** Distribute the `next - current` delta equally to every contributor.
 *  Dual to `mean` on the merge side. Requires the `linear` trait. */
export const deltaEven: Writeback = traits => {
  const lin = needLinear(traits as TraitDict<unknown>, "deltaEven");
  return (next, parts) => {
    if (parts.length === 0) return [];
    let cur = parts[0]!.value;
    for (let i = 1; i < parts.length; i++) cur = lin.add(cur, parts[i]!.value);
    cur = lin.scale(cur, 1 / parts.length);
    const delta = lin.sub(next, cur);
    const out: unknown[] = new Array(parts.length);
    for (let i = 0; i < parts.length; i++) out[i] = lin.add(parts[i]!.value, delta);
    return out;
  };
};

/** Write to the first contributor only; leave the rest untouched.
 *  Trait-free. Useful when one contributor is the "primary" source
 *  and the others are read-only constraints / projections. */
export const replaceFirst: Writeback = () => (next, parts) => {
  if (parts.length === 0) return [];
  const out: unknown[] = new Array(parts.length);
  out[0] = next;
  for (let i = 1; i < parts.length; i++) out[i] = parts[i]!.value;
  return out;
};

/** Distribute the delta proportionally to each contributor's weight.
 *  High-weight contributors absorb more of the residual. Requires
 *  Linear. Falls back to `deltaEven` when total weight is 0. */
export const proportional: Writeback = traits => {
  const lin = needLinear(traits as TraitDict<unknown>, "proportional");
  // Pre-resolve `deltaEven`'s fallback path too, so the zero-weight
  // branch doesn't pay the trait lookup either.
  const fallback = deltaEven(traits);
  return (next, parts) => {
    if (parts.length === 0) return [];
    let cur = lin.scale(parts[0]!.value, parts[0]!.weight);
    let total = parts[0]!.weight;
    for (let i = 1; i < parts.length; i++) {
      cur = lin.add(cur, lin.scale(parts[i]!.value, parts[i]!.weight));
      total += parts[i]!.weight;
    }
    if (total === 0) return fallback(next, parts);
    cur = lin.scale(cur, 1 / total);
    const delta = lin.sub(next, cur);
    const out: unknown[] = new Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const share = parts[i]!.weight / total;
      out[i] = lin.add(parts[i]!.value, lin.scale(delta, share));
    }
    return out;
  };
};

// ─── Merge combinators ──────────────────────────────────────────────
//
// Each combinator pre-resolves `base(traits)` ONCE at construction so
// inner per-eval calls hit only the prepared closure. Layered
// combinators (e.g. `above(0.1, top(3, mean))`) compose cleanly — the
// trait dependency propagates outward.

/** Take only the top `n` contributors by weight before applying `base`. */
export const top =
  <T>(n: number, base: Merge<T>): Merge<T> =>
  traits => {
    const prepared = base(traits);
    return parts =>
      prepared([...parts].sort((a, b) => b.weight - a.weight).slice(0, Math.max(0, n)));
  };

/** Drop contributors whose weight is `≤ threshold`, then apply `base`. */
export const above =
  <T>(threshold: number, base: Merge<T>): Merge<T> =>
  traits => {
    const prepared = base(traits);
    return parts => prepared(parts.filter(p => p.weight > threshold));
  };

/** Re-map each contributor's weight via `fn` before applying `base`.
 *  Useful for non-linear weighting (exp, softmax, …). */
export const reweight =
  <T>(fn: (p: Contribution<T>) => number, base: Merge<T>): Merge<T> =>
  traits => {
    const prepared = base(traits);
    return parts => prepared(parts.map(p => ({ value: p.value, weight: fn(p) })));
  };

// ─── Trait-lookup helpers (public) ──────────────────────────────────
//
// Authors of custom trait-needing merges/writebacks should call these
// in the OUTER stage so the impl is captured in the inner closure —
// avoiding per-eval lookups. Example:
//
//   const myMerge: Merge = (traits) => {
//     const lin = needLinear(traits, "myMerge");
//     return (parts) => …;          // hot path: no trait lookup
//   };

/** Look up the `linear` trait on a class's `TraitDict`. Throws with a
 *  named error if absent. */
export function needLinear<T>(traits: TraitDict<T>, name: string): Linear<T> {
  if (!traits.linear) {
    throw new Error(`mix(${name}): value class has no 'linear' trait`);
  }
  return traits.linear;
}

// ─── Internals ──────────────────────────────────────────────────────

interface InternalPart<T> {
  readonly src: Read<T>;
  readonly weight: () => number;
}

function normalizePart<T>(p: Part<T>): InternalPart<T> {
  // Record form: { src, weight? }
  if (typeof p === "object" && p !== null && !(p instanceof Signal) && "src" in p) {
    const { src, weight } = p as { src: Val<T>; weight?: Val<number> };
    return {
      src: srcOf(src),
      weight: weight !== undefined ? valFn(weight) : () => 1,
    };
  }
  // Bare Val<T> form
  return { src: srcOf(p as Val<T>), weight: () => 1 };
}

function srcOf<T>(v: Val<T>): Read<T> {
  if (v instanceof Signal) return v as Read<T>;
  // Wrap a thunk in a tracked computed so closure-read signals become deps.
  if (typeof v === "function") return computed(v as () => T) as Read<T>;
  // Literal — frozen contribution.
  return signal(v as T) as unknown as Read<T>;
}

// ─── The factory ────────────────────────────────────────────────────

// `Signal<any>` (bivariant) rather than `Signal<unknown>` (invariant)
// so concrete value classes (Vec, Num, …) satisfy the constraint and
// `T` is recovered via `C extends Signal<infer T>`.

// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function mix<C extends Signal<any>>(
  Cls: new (...args: never[]) => C,
  parts: readonly Part<C extends Signal<infer T> ? T : never>[],
  merge: Merge<C extends Signal<infer T> ? T : never>,
): C;
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function mix<C extends Signal<any>>(
  Cls: new (...args: never[]) => C,
  parts: readonly Part<C extends Signal<infer T> ? T : never>[],
  merge: Merge<C extends Signal<infer T> ? T : never>,
  writeback: Writeback<C extends Signal<infer T> ? T : never>,
): Writable<C>;
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function mix<C extends Signal<any>>(
  Cls: new (...args: never[]) => C,
  parts: readonly Part<unknown>[],
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  merge: Merge<any>,
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  writeback?: Writeback<any>,
): C | Writable<C> {
  type T = C extends Signal<infer U> ? U : never;
  const traits = ((Cls as unknown as { traits?: TraitDict<T> }).traits ?? {}) as TraitDict<T>;

  const n = parts.length;
  const members: InternalPart<T>[] = new Array(n);
  for (let i = 0; i < n; i++) members[i] = normalizePart(parts[i] as Part<T>);

  // Pre-allocated scratch buffer: one outer array + N Contribution
  // records, mutated in place across reads/writes. Avoids the per-eval
  // allocation that fresh-array approaches pay.
  const scratch: Contribution<T>[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Cast off `readonly` for the slot; merge/writeback fns must not
    // retain `parts` across calls (the same records get rewritten).
    scratch[i] = { value: undefined as unknown as T, weight: 0 } as Contribution<T>;
  }

  function fillScratch(tracked: boolean): void {
    for (let i = 0; i < n; i++) {
      const m = members[i]!;
      const c = scratch[i] as { value: T; weight: number };
      c.value = tracked ? m.src.value : m.src.peek();
      c.weight = m.weight();
    }
  }

  // Trait pre-resolution: call each merge/writeback's outer stage
  // ONCE here so trait lookups + `needLinear` checks happen at
  // construction. The hot getter/setter close over the prepared inner
  // functions and never touch the traits dict.
  const prepMerge = merge(traits);
  const prepWriteback = writeback !== undefined ? writeback(traits) : undefined;

  const getter = (): T => {
    fillScratch(true);
    return prepMerge(scratch);
  };

  // Dispatch on writeback presence — `Signal.install` is overloaded
  // on arity (2-arg → RO, 3-arg → RW) so we can't pass `undefined`.
  if (prepWriteback === undefined) {
    return Signal.install(
      Cls as unknown as new (
        ...args: never[]
      ) => Signal<T>,
      getter,
    ) as unknown as C;
  }
  const setter = (next: T): void => {
    fillScratch(false);
    const newVals = prepWriteback(next, scratch);
    if (newVals.length !== n) {
      throw new Error(`mix writeback: returned ${newVals.length} values for ${n} parts`);
    }
    for (let i = 0; i < n; i++) {
      const src = members[i]!.src;
      if (src instanceof Signal) (src as Signal<T>).value = newVals[i]!;
    }
  };
  return Signal.install(
    Cls as unknown as new (
      ...args: never[]
    ) => Signal<T>,
    getter,
    setter,
  ) as Writable<C>;
}
