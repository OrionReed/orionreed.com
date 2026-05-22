// mix.ts — N-to-1 derived view with mutable membership and a chosen
// merge function.
//
// `mix(Cls, merge)` is `combine(parts, merge, …)` extended so
// contributors can be added/removed after construction. Each
// contributor is a `Val<T>` (signal, thunk, or literal), optionally
// with a reactive `weight`. The result is a value-class instance
// (Vec, Num, …) so it composes uniformly with the rest of the
// signal-axis algebra (`centroid`, `polar`, `.scale`, lensing, etc.).
//
// Merges are first-class values, not strings — so they compose. Each
// is a `(parts, traits) => T` function; `mix` passes the value class's
// trait dictionary so trait-needing merges (`mean`, `sum`) can look up
// the relevant impl. Combinators like `top`, `above`, and `reweight`
// take a base merge and return a new one.
//
// Reads are tracked: each contributor's `.value` becomes a dep. Adding
// or removing contributors invalidates the view via an internal
// version signal, so existing subscribers re-fire and re-track. Writes
// to the merged result currently throw — bidirectional writeback
// (delta distribution per merge) is a future extension, dual to
// `combine`'s `distribute` arm.

import { computed, type Read, Signal, signal, type Val, valFn } from "./signal";
import { type Linear, type TraitDict } from "./traits";
import { type Writable } from "./writable";

// ─── Public types ────────────────────────────────────────────────────

export interface MixAddOpts {
  /** Per-contributor weight. Reactive: re-read each evaluation. Default 1. */
  weight?: Val<number>;
}

export interface Contribution<T> {
  readonly value: T;
  readonly weight: number;
}

/** A merge is a pure function from (parts, traits) to a single value.
 *
 *  Trait-needing merges (`mean`, `sum`) read what they need from the
 *  passed `traits` dictionary; trait-free merges (`priority`, `latest`)
 *  ignore it. Combinators like `top(n, base)` take a `Merge` and
 *  return a new `Merge`, so user code composes merges by ordinary
 *  function composition.
 *
 *  Default `T = any` is deliberate: built-in merge values (`Merges.mean`,
 *  `Merges.sum`, …) need to be assignable to `Merge<V>` for any `V`,
 *  and `T` participates contravariantly in `traits: TraitDict<T>`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape for built-ins
export type Merge<T = any> = (parts: readonly Contribution<T>[], traits: TraitDict<T>) => T;

/** Mix is a value-class instance plus mutable-contributor methods. */
export type Mix<C> = C & {
  /** Add a contributor; returns a disposer that removes it. */
  add(member: C extends Read<infer T> ? Val<T> : never, opts?: MixAddOpts): () => void;
  /** Allocate a fresh writable port of the same class, register it as
   *  a contributor, and return it. The caller writes to the port; the
   *  port's value contributes to the mix. */
  port(initial?: C extends Read<infer T> ? T : never): Writable<C>;
};

// ─── Built-in merges ────────────────────────────────────────────────

/** Weighted mean, normalised by total weight. Equal-weight mean is
 *  the special case where every contributor was added without a weight
 *  (defaulting to 1). Requires the `linear` trait. */
export const mean: Merge = (parts, traits) => {
  const lin = needLinear(traits as TraitDict<unknown>, "mean");
  if (parts.length === 0) throw new Error("mix(mean): no contributors");
  let acc = lin.scale(parts[0]!.value, parts[0]!.weight);
  let total = parts[0]!.weight;
  for (let i = 1; i < parts.length; i++) {
    acc = lin.add(acc, lin.scale(parts[i]!.value, parts[i]!.weight));
    total += parts[i]!.weight;
  }
  // All-zero weights: fall back to first contribution to avoid NaN.
  return total === 0 ? parts[0]!.value : lin.scale(acc, 1 / total);
};

/** Weighted sum (no normalisation). Requires the `linear` trait. */
export const sum: Merge = (parts, traits) => {
  const lin = needLinear(traits as TraitDict<unknown>, "sum");
  if (parts.length === 0) throw new Error("mix(sum): no contributors");
  let acc = lin.scale(parts[0]!.value, parts[0]!.weight);
  for (let i = 1; i < parts.length; i++) {
    acc = lin.add(acc, lin.scale(parts[i]!.value, parts[i]!.weight));
  }
  return acc;
};

/** Highest-weight contributor wins. Ties resolved by add-order
 *  (first added). Trait-free. */
export const priority: Merge = parts => {
  if (parts.length === 0) throw new Error("mix(priority): no contributors");
  let best = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]!.weight > best.weight) best = parts[i]!;
  }
  return best.value;
};

/** Last contributor (in add-order) wins. Trait-free. */
export const latest: Merge = parts => {
  if (parts.length === 0) throw new Error("mix(latest): no contributors");
  return parts[parts.length - 1]!.value;
};

/** First non-null contribution wins. Useful for default/fallback chains. */
export const firstNonNull: Merge = parts => {
  for (const p of parts) if (p.value != null) return p.value;
  if (parts.length === 0) throw new Error("mix(firstNonNull): no contributors");
  return parts[0]!.value;
};

// ─── Merge combinators ──────────────────────────────────────────────

/** Take only the top `n` contributors by weight before applying `base`. */
export const top =
  <T>(n: number, base: Merge<T>): Merge<T> =>
  (parts, traits) =>
    base([...parts].sort((a, b) => b.weight - a.weight).slice(0, Math.max(0, n)), traits);

/** Drop contributors whose weight is `≤ threshold`, then apply `base`. */
export const above =
  <T>(threshold: number, base: Merge<T>): Merge<T> =>
  (parts, traits) =>
    base(
      parts.filter(p => p.weight > threshold),
      traits,
    );

/** Re-map each contributor's weight via `fn` before applying `base`.
 *  Useful for non-linear weighting (e.g. exp, softmax). */
export const reweight =
  <T>(fn: (p: Contribution<T>) => number, base: Merge<T>): Merge<T> =>
  (parts, traits) =>
    base(
      parts.map(p => ({ value: p.value, weight: fn(p) })),
      traits,
    );

// ─── Internals ──────────────────────────────────────────────────────

function needLinear<T>(traits: TraitDict<T>, name: string): Linear<T> {
  if (!traits.linear) {
    throw new Error(`mix(${name}): value class has no 'linear' trait`);
  }
  return traits.linear;
}

interface Member<T> {
  readonly src: Read<T>;
  readonly weight: () => number;
}

// ─── The mix factory ────────────────────────────────────────────────

// `Signal<any>` (bivariant) rather than `Signal<unknown>` (invariant)
// so concrete value classes (Vec, Num, …) satisfy the constraint and
// `T` is recovered via `C extends Signal<infer T>`.
// biome-ignore lint/suspicious/noExplicitAny: deliberate variance escape
export function mix<C extends Signal<any>>(
  Cls: new (...args: never[]) => C,
  merge: Merge<C extends Signal<infer T> ? T : never>,
): Mix<C> {
  type T = C extends Signal<infer U> ? U : never;
  const traits = ((Cls as unknown as { traits?: TraitDict<T> }).traits ?? {}) as TraitDict<T>;
  const members: Member<T>[] = [];
  // Membership-version signal: bumping invalidates the lens view's
  // tracked deps, so add/remove always triggers a re-evaluation that
  // re-tracks the current contributor set.
  const version = new Signal(0);

  const view = Signal.install<T, Signal<T>>(
    Cls as unknown as new (
      ...args: never[]
    ) => Signal<T>,
    () => {
      void version.value;
      const parts: Contribution<T>[] = new Array(members.length);
      for (let i = 0; i < members.length; i++) {
        parts[i] = { value: members[i]!.src.value, weight: members[i]!.weight() };
      }
      return merge(parts, traits);
    },
  );

  function add(member: Val<T>, opts?: MixAddOpts): () => void {
    let src: Read<T>;
    if (member instanceof Signal) {
      src = member as Read<T>;
    } else if (typeof member === "function") {
      // Wrap a thunk in a tracked computed so closure-read signals are
      // picked up as deps of the mix.
      src = computed(member as () => T) as Read<T>;
    } else {
      // Literal — frozen contribution. Uniform handling so callers
      // don't have to allocate a signal for one-shot constants.
      src = signal(member as T) as unknown as Read<T>;
    }
    const weight = opts?.weight !== undefined ? valFn(opts.weight) : () => 1;
    const entry: Member<T> = { src, weight };
    members.push(entry);
    version.value = version.value + 1;
    return () => {
      const i = members.indexOf(entry);
      if (i >= 0) {
        members.splice(i, 1);
        version.value = version.value + 1;
      }
    };
  }

  function port(initial?: T): Writable<C> {
    // `Cls` accepts `(...args: never[])` at the type level; the
    // shipped value classes (Num, Vec, Box, …) all default-construct.
    const sig = new (Cls as unknown as new () => C)();
    if (initial !== undefined) (sig as unknown as Signal<T>).value = initial;
    add(sig as unknown as Val<T>);
    return sig as unknown as Writable<C>;
  }

  // biome-ignore lint/suspicious/noExplicitAny: ops have already been narrowed
  Object.assign(view as any, { add, port });
  return view as unknown as Mix<C>;
}
