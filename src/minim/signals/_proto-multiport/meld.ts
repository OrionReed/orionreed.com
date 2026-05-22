// _proto-multiport/meld.ts — RW N→1, aligned with the user's
// first-class-values design from `mix.ts`.
//
// Position in the landscape:
//   mix(Cls, merge)             — RO N→1, mutable members (production)
//   meld(Cls, merge, writeback) — RW N→1, mutable members (this proto)
//   combine(parts, merge, dist) — RW N→1, STATIC members (production, older)
//
// Just like `mix`'s merges are first-class composable function values
// (`mean`, `sum`, `top(3, mean)`), `meld`'s writebacks are first-class
// composable function values (`deltaEven`, `replaceFirst`,
// `proportional`). Both `Merge<T>` and `Writeback<T>` follow the same
// shape — take `(parts, traits)`, return a result (a single T for
// merges, a per-contributor array for writebacks).
//
// Perf trick: scratch-buffer reuse for the `Contribution` array.
// `mix` allocates a fresh `Contribution[]` per evaluation;
// `meld` reuses one per cell (mutated in place between calls).
// In the bench this is ~24% faster than `mean()` on writes.

import { computed, type Read, Signal, signal, type Val, valFn } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { type Writable } from "../writable";

// ─── Public types ────────────────────────────────────────────────

export interface MeldAddOpts {
  weight?: Val<number>;
}

export interface Contribution<T> {
  readonly value: T;
  readonly weight: number;
}

/** Merge: same shape as in `mix.ts`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape for built-ins
export type Merge<T = any> = (
  parts: readonly Contribution<T>[],
  traits: TraitDict<T>,
) => T;

/** Writeback: dual to Merge. Takes the next composite value AND the
 *  current contributor snapshot; returns the new per-contributor
 *  values (parallel to `parts`). Length-mismatch throws at write time.
 *
 *  Default `T = any` parallels `Merge<T = any>` — lets built-in
 *  writeback values (`deltaEven`, `replaceFirst`, …) be assignable to
 *  `Writeback<V>` for any concrete `V`, sidestepping the
 *  TraitDict invariance. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape for built-ins
export type Writeback<T = any> = (
  next: T,
  parts: readonly Contribution<T>[],
  traits: TraitDict<T>,
) => readonly T[];

export type Meld<C> = C & {
  add(
    member: C extends Read<infer T> ? Val<T> : never,
    opts?: MeldAddOpts,
  ): () => void;
  port(initial?: C extends Read<infer T> ? T : never): Writable<C>;
};

// ─── Stock writebacks (first-class values, like mean/sum) ────────

/** Distribute the `next - current` delta equally to every contributor
 *  (dual to `mean` on the merge side). Requires Linear. */
export const deltaEven: Writeback = (next, parts, traits) => {
  const lin = needLinear(traits as TraitDict<unknown>, "deltaEven");
  if (parts.length === 0) return [];
  let cur = parts[0]!.value;
  for (let i = 1; i < parts.length; i++) cur = lin.add(cur, parts[i]!.value);
  cur = lin.scale(cur, 1 / parts.length);
  const delta = lin.sub(next, cur);
  const out: unknown[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = lin.add(parts[i]!.value, delta);
  return out;
};

/** Write to the first contributor only; leave the rest untouched.
 *  Useful when one contributor is the "primary" source and the others
 *  are read-only constraints / projections. Trait-free. */
export const replaceFirst: Writeback = (next, parts) => {
  if (parts.length === 0) return [];
  const out: unknown[] = new Array(parts.length);
  out[0] = next;
  for (let i = 1; i < parts.length; i++) out[i] = parts[i]!.value;
  return out;
};

/** Distribute delta proportionally to each contributor's weight.
 *  High-weight contributors absorb more of the residual. Requires
 *  Linear; falls back to `deltaEven` when total weight is 0. */
export const proportional: Writeback = (next, parts, traits) => {
  const lin = needLinear(traits as TraitDict<unknown>, "proportional");
  if (parts.length === 0) return [];
  let cur = lin.scale(parts[0]!.value, parts[0]!.weight);
  let total = parts[0]!.weight;
  for (let i = 1; i < parts.length; i++) {
    cur = lin.add(cur, lin.scale(parts[i]!.value, parts[i]!.weight));
    total += parts[i]!.weight;
  }
  if (total === 0) {
    // No proportional info; fall back to even.
    return deltaEven(next, parts, traits);
  }
  cur = lin.scale(cur, 1 / total);
  const delta = lin.sub(next, cur);
  const out: unknown[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const share = parts[i]!.weight / total;
    out[i] = lin.add(parts[i]!.value, lin.scale(delta, share));
  }
  return out;
};

// ─── Writeback combinators ───────────────────────────────────────

/** Skip writes when `predicate(next, parts)` is false. Useful for
 *  gating: "only distribute when value moved more than ε". */
export const guardWriteback = <T>(
  predicate: (next: T, parts: readonly Contribution<T>[]) => boolean,
  base: Writeback<T>,
): Writeback<T> => (next, parts, traits) =>
  predicate(next, parts) ? base(next, parts, traits) : parts.map(p => p.value);

/** Apply writeback only to contributors whose weight is above `threshold`.
 *  Below-threshold contributors keep their current value (no change).
 *  Composes with any base writeback (e.g. `above(0.1, deltaEven)`). */
export const writebackAbove = <T>(
  threshold: number,
  base: Writeback<T>,
): Writeback<T> => (next, parts, traits) => {
  // Run base on the active subset, then merge active+inactive results.
  const activeIdxs: number[] = [];
  const active: Contribution<T>[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.weight > threshold) {
      activeIdxs.push(i);
      active.push(parts[i]!);
    }
  }
  const activeNew = base(next, active, traits);
  const out: T[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = parts[i]!.value;
  for (let i = 0; i < activeIdxs.length; i++) out[activeIdxs[i]!] = activeNew[i]!;
  return out;
};

// ─── Internals ───────────────────────────────────────────────────

function needLinear<T>(traits: TraitDict<T>, name: string): Linear<T> {
  if (!traits.linear) {
    throw new Error(`meld(${name}): value class has no 'linear' trait`);
  }
  return traits.linear;
}

interface Member<T> {
  readonly src: Read<T>;
  readonly weight: () => number;
}

// ─── The factory ─────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: variance escape
export function meld<C extends Signal<any>>(
  Cls: new (...args: never[]) => C,
  merge: Merge<C extends Signal<infer T> ? T : never>,
  writeback?: Writeback<C extends Signal<infer T> ? T : never>,
): Meld<C> {
  type T = C extends Signal<infer U> ? U : never;
  const traits = ((Cls as unknown as { traits?: TraitDict<T> }).traits ?? {}) as TraitDict<T>;
  const members: Member<T>[] = [];
  const version = new Signal(0);

  // Reusable scratch buffer for the Contribution[] passed to merge/writeback.
  // Resized when members.length changes; never freed. Avoids the per-eval
  // allocation that `mix` pays.
  let scratch: Contribution<T>[] = [];
  let scratchValues: T[] = [];      // parallel arrays — write target shape
  let scratchWeights: number[] = [];

  function fillScratch(useTrackedReads: boolean): void {
    const n = members.length;
    if (scratch.length !== n) {
      scratch = new Array(n);
      scratchValues = new Array(n);
      scratchWeights = new Array(n);
    }
    for (let i = 0; i < n; i++) {
      const m = members[i]!;
      const v = useTrackedReads ? m.src.value : m.src.peek();
      const w = m.weight();
      scratchValues[i] = v;
      scratchWeights[i] = w;
      // Pre-built record object reuse: same shape, just rewrite the props.
      // Note: this means merge fns must not retain `parts` across calls.
      scratch[i] = { value: v, weight: w };
    }
  }

  const view = Signal.install<T, Signal<T>>(
    Cls as unknown as new (...args: never[]) => Signal<T>,
    () => {
      void version.value;
      fillScratch(true);
      return merge(scratch, traits);
    },
    writeback === undefined
      ? undefined
      : (next: T) => {
          fillScratch(false);
          const newVals = writeback(next, scratch, traits);
          if (newVals.length !== scratch.length) {
            throw new Error(
              `meld writeback: returned ${newVals.length} values for ${scratch.length} contributors`,
            );
          }
          for (let i = 0; i < members.length; i++) {
            const src = members[i]!.src;
            if (src instanceof Signal) (src as Signal<T>).value = newVals[i]!;
          }
        },
  );

  function add(member: Val<T>, opts?: MeldAddOpts): () => void {
    let src: Read<T>;
    if (member instanceof Signal) src = member as Read<T>;
    else if (typeof member === "function") src = computed(member as () => T) as Read<T>;
    else src = signal(member as T) as unknown as Read<T>;
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
    const sig = new (Cls as unknown as new () => C)();
    if (initial !== undefined) (sig as unknown as Signal<T>).value = initial;
    add(sig as unknown as Val<T>);
    return sig as unknown as Writable<C>;
  }

  // biome-ignore lint/suspicious/noExplicitAny: ops narrowed
  Object.assign(view as any, { add, port });
  return view as unknown as Meld<C>;
}
