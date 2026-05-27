// wp-unified.ts — the unified API surface.
//
// Goal: a single set of method names where any parameter can be a
// literal, a Read-only signal, or a Writable signal — and the bwd
// behaves accordingly. Return type is always Writable<...>.
//
// This is the user's vision: zero new types at the call site; the
// runtime decides per-param.

import { isSignal, type Init, Num, type Read, reader, Signal, type Val, Vec, type Writable } from "../../index";
import { lensTracked, type LensWOpts } from "./wp-detect";

type V = { x: number; y: number };

function isWritable(v: unknown): boolean {
  if (!(v instanceof Signal)) return false;
  const s = v as Signal<unknown>;
  return s.getter === undefined || s.setter !== undefined;
}

// ─── Method-style API: vec.right(n) chooses semantics by n's flavor ─

export interface UnifiedOpts extends LensWOpts {
  /** When n is a writable signal, what fraction of x-delta does it
   *  absorb? 0 = a absorbs (RO-style); 1 = n absorbs (wp-style).
   *  Default 1 — natural for "n is the offset; sliding the result
   *  should slide n". */
  paramWeight?: number;
}

/** Unified `a.right(n)`:
 *  - n literal or Read-only: behaves like a.right(n) today.
 *  - n Writable: behaves like vecRightWeighted(a, n, paramWeight). */
export function uRight(
  a: Writable<Vec>,
  n: Val<number> | Writable<Num>,
  opts: UnifiedOpts = {},
): Writable<Vec> {
  const w = opts.paramWeight ?? 1;
  if (isWritable(n)) {
    const nSig = n as Writable<Num>;
    return lensTracked(
      [a, nSig] as const,
      ([av, nv]) => ({ x: av.x + nv, y: av.y }),
      (target, [av, nv]) => {
        const cur = av.x + nv;
        const dx = target.x - cur;
        return [
          { x: av.x + dx * (1 - w), y: target.y },
          nv + dx * w,
        ] as const;
      },
      Vec,
      opts,
    );
  }
  // RO/literal path
  const f = reader(n as Val<number>);
  return a.lens(
    v => ({ x: v.x + f(), y: v.y }),
    o => ({ x: o.x - f(), y: o.y }),
  );
}

/** Unified `a.scale(k)`. Same dispatch logic. */
export function uScale(
  a: Writable<Num>,
  k: Val<number> | Writable<Num>,
  opts: UnifiedOpts = {},
): Writable<Num> {
  const w = opts.paramWeight ?? 1;
  if (isWritable(k)) {
    const kSig = k as Writable<Num>;
    return lensTracked(
      [a, kSig] as const,
      ([av, kv]) => av * kv,
      (target, [av, kv]) => {
        // Underdetermined: a*k = target has infinitely many (a, k) pairs.
        // Policy: w controls how much k absorbs vs a.
        // If w == 1: k := target / av  (a unchanged)
        // If w == 0: a := target / kv  (k unchanged)
        // Else: split toward the geometric mean.
        if (w === 1) {
          if (av === 0) return [undefined, kv] as const;
          return [undefined, target / av] as const;
        }
        if (w === 0) {
          if (kv === 0) return [av, undefined] as const;
          return [target / kv, undefined] as const;
        }
        // Mixed: lerp in log-space. Skipped for prototype.
        // Default to w=1 fallback.
        if (av === 0) return [undefined, kv] as const;
        return [undefined, target / av] as const;
      },
      Num,
      opts,
    );
  }
  return a.scale(k as Val<number>);
}

/** Unified `a.add(b)`. */
export function uAdd(
  a: Writable<Num>,
  b: Val<number> | Writable<Num>,
  opts: UnifiedOpts = {},
): Writable<Num> {
  const w = opts.paramWeight ?? 0.5;
  if (isWritable(b)) {
    const bSig = b as Writable<Num>;
    return lensTracked(
      [a, bSig] as const,
      ([av, bv]) => av + bv,
      (target, [av, bv]) => {
        const delta = target - (av + bv);
        return [av + delta * (1 - w), bv + delta * w] as const;
      },
      Num,
      opts,
    );
  }
  return a.add(b as Val<number>);
}
