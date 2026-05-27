// wp-bool.ts — writable predicates with writable thresholds.
//
// The most interesting wp case at the cross-type level: a Bool that's
// the projection of a Num through a threshold. With a writable threshold,
// flipping the Bool can either move the value OR the threshold —
// designer's choice.

import { Bool, Num, type Writable } from "../../index";
import { lensTracked, type LensWOpts } from "./wp-detect";

/** `n > t`. Flipping the result moves the THRESHOLD (not the value).
 *  Setting to `true` while currently `false` (n <= t) → t := n - eps.
 *  Setting to `false` while currently `true` (n > t) → t := n + eps.
 *  Useful for "calibrate the threshold by flipping the indicator". */
export function greaterThanW(
  n: Writable<Num>,
  t: Writable<Num>,
  eps: number = 1e-6,
  opts: LensWOpts = {},
): Writable<Bool> {
  return lensTracked(
    [n, t] as const,
    ([nv, tv]) => nv > tv,
    (target, [nv, tv]) => {
      const current = nv > tv;
      if (target === current) return [undefined, undefined] as const;
      // Move the threshold across n.
      return [undefined, target ? nv - eps : nv + eps] as const;
    },
    Bool,
    opts,
  );
}

/** `n > t`. Flipping the result moves the VALUE (not the threshold).
 *  Setting to `true` → n := t + eps. Useful for "force the system into
 *  the active state by clicking the indicator". */
export function greaterThanWvalue(
  n: Writable<Num>,
  t: Writable<Num>,
  eps: number = 1e-6,
  opts: LensWOpts = {},
): Writable<Bool> {
  return lensTracked(
    [n, t] as const,
    ([nv, tv]) => nv > tv,
    (target, [nv, tv]) => {
      const current = nv > tv;
      if (target === current) return [undefined, undefined] as const;
      return [target ? tv + eps : tv - eps, undefined] as const;
    },
    Bool,
    opts,
  );
}

/** `n > t`. Flipping moves BOTH, meeting in the middle. The threshold
 *  drops below n; n stays above t. Maintains "n > t" by adjusting both
 *  by half the (n-t) distance. Probably useless but illustrative. */
export function greaterThanWsplit(
  n: Writable<Num>,
  t: Writable<Num>,
  eps: number = 1e-6,
  opts: LensWOpts = {},
): Writable<Bool> {
  return lensTracked(
    [n, t] as const,
    ([nv, tv]) => nv > tv,
    (target, [nv, tv]) => {
      const current = nv > tv;
      if (target === current) return [undefined, undefined] as const;
      const mid = (nv + tv) / 2;
      const sep = eps / 2;
      return target ? [mid + sep, mid - sep] : [mid - sep, mid + sep];
    },
    Bool,
    opts,
  );
}

// ─── AND with writable parents (vs. today's `a.and(b): Bool` RO) ───

/** Writable AND. Click `true` while `false` → flip BOTH parents to true.
 *  Click `false` while `true` → flip ONLY `a` to false (arbitrary choice;
 *  see comment). */
export function andW(
  a: Writable<Bool>,
  b: Writable<Bool>,
  opts: LensWOpts = {},
): Writable<Bool> {
  return lensTracked(
    [a, b] as const,
    ([av, bv]) => av && bv,
    (target, [av, bv]) => {
      const cur = av && bv;
      if (target === cur) return [undefined, undefined] as const;
      if (target) return [true, true] as const;
      // false ← true: at least one must flip. ARBITRARY: choose a.
      // The footgun: this asymmetry isn't visible at use site.
      return [false, undefined] as const;
    },
    Bool,
    opts,
  );
}

/** Writable OR. Click `false` while `true` → flip BOTH to false.
 *  Click `true` while `false` → flip ONLY `a` to true. */
export function orW(
  a: Writable<Bool>,
  b: Writable<Bool>,
  opts: LensWOpts = {},
): Writable<Bool> {
  return lensTracked(
    [a, b] as const,
    ([av, bv]) => av || bv,
    (target, [av, bv]) => {
      const cur = av || bv;
      if (target === cur) return [undefined, undefined] as const;
      if (!target) return [false, false] as const;
      return [true, undefined] as const;
    },
    Bool,
    opts,
  );
}
