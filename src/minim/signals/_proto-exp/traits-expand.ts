// _proto-exp/traits-expand.ts — additional traits and generic lens
// constructors driven by them.
//
// Today's traits (Linear/Lerp/Metric/Equals) power animators (spring,
// tween, attract, mean). They're "what algebraic structure does T
// admit?" — which generic operations make sense.
//
// What's missing: traits that would let CURRENTLY-SPECIALIZED lens
// methods become generic. `Num.clamp(lo, hi)` only works on Num. With
// `Ordered<T>`, it'd work on any T that knows how to compare. Similarly
// for `quantize` (Discrete<T>) and `cyclic` (Cyclic<T>).
//
// Sketch shape:
//   - Three new trait interfaces (Ordered, Discrete, Cyclic).
//   - Three generic free-function constructors that ride on `.through()`
//     and the runtime trait dict.
//
// If we like the shape, these slot into traits.ts proper; the per-class
// `.clamp` / `.quantize` / `.cyclic` methods get deleted and replaced
// by these generic helpers (or method-level dispatch via the trait).

import { type Signal, type Val, valFn } from "../signal";
import type { TraitDict, Traits } from "../traits";

// ─── New trait interfaces ────────────────────────────────────────

export interface Ordered<T> {
  /** Total order: returns negative / 0 / positive like `Array.sort`. */
  compare(a: T, b: T): number;
}

export interface Discrete<T> {
  /** Snap `v` to the closest representative on the step grid. The
   *  `step` is opaque — for Num it's `number`, for Vec it could be
   *  a per-axis step, etc. Picking the right shape per type is what
   *  the trait is for. */
  snap(v: T, step: T): T;
}

export interface Cyclic<T> {
  /** Choose the representative of `target` closest to `current` under
   *  the cyclic period. Used for shortest-arc semantics. */
  nearest(target: T, current: T, period: T): T;
}

// ─── Extended TraitDict (would merge into traits.ts proper) ──────

// This is what we'd add to TraitDict<T> if we shipped these:
//   interface TraitDict<T> {
//     ...
//     ordered?: Ordered<T>;
//     discrete?: Discrete<T>;
//     cyclic?: Cyclic<T>;
//   }
// For the prototype we use a local dict augmentation via cast.

interface ExtTraitDict<T> extends TraitDict<T> {
  ordered?: Ordered<T>;
  discrete?: Discrete<T>;
  cyclic?: Cyclic<T>;
}

function extDictOf<T>(s: Signal<T>): ExtTraitDict<T> {
  return ((s.constructor as { traits?: ExtTraitDict<T> }).traits) ?? {};
}

// ─── Generic constructors driven by traits ───────────────────────

/** Generic clamp: works for any T whose class declares Ordered<T>.
 *  Returns a same-type lens that clamps reads to `[lo, hi]` and clamps
 *  writes before propagating. PutGet-only compliance (same as today's
 *  Num.clamp). */
export function clamp<T>(
  cell: Signal<T> & Traits<T, never>,
  lo: Val<T>,
  hi: Val<T>,
): Signal<T> {
  const ord = extDictOf(cell).ordered;
  const name = (cell.constructor as { name?: string }).name ?? "?";
  if (!ord) throw new Error(`clamp: ${name} has no traits.ordered`);
  const lf = valFn(lo);
  const hf = valFn(hi);
  const c = (v: T): T => {
    const l = lf();
    const h = hf();
    if (ord.compare(v, l) < 0) return l;
    if (ord.compare(v, h) > 0) return h;
    return v;
  };
  return (cell as unknown as { through(f: (v: T) => T, b: (v: T) => T): Signal<T> }).through(c, c);
}

/** Generic quantize: works for any T whose class declares Discrete<T>.
 *  Snaps reads and writes to the nearest step. */
export function quantize<T>(
  cell: Signal<T> & Traits<T, never>,
  step: Val<T>,
): Signal<T> {
  const disc = extDictOf(cell).discrete;
  const name = (cell.constructor as { name?: string }).name ?? "?";
  if (!disc) throw new Error(`quantize: ${name} has no traits.discrete`);
  const sf = valFn(step);
  const q = (v: T): T => disc.snap(v, sf());
  return (cell as unknown as { through(f: (v: T) => T, b: (v: T) => T): Signal<T> }).through(q, q);
}

/** Generic cyclic: works for any T whose class declares Cyclic<T>.
 *  Reads pass through; writes pick the representative closest to
 *  the current value modulo `period`. */
export function cyclic<T>(
  cell: Signal<T> & Traits<T, never>,
  period: Val<T>,
): Signal<T> {
  const cyc = extDictOf(cell).cyclic;
  const name = (cell.constructor as { name?: string }).name ?? "?";
  if (!cyc) throw new Error(`cyclic: ${name} has no traits.cyclic`);
  const pf = valFn(period);
  return (cell as unknown as {
    through(f: (v: T) => T, b: (v: T) => T): Signal<T>;
    peek(): T;
  }).through(
    (v) => v,
    (v) => cyc.nearest(v, (cell as unknown as { peek(): T }).peek(), pf()),
  );
}
