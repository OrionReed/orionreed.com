// wp-policy.ts — reactively-parametrised weights and policies.
//
// The "policy" of a wp lens (how the bwd splits writes) is itself a
// cell. Drag a slider that controls the policy; the lens re-aims its
// bwd accordingly.
//
// This is the "lens whose law is itself a cell" idea from the chat —
// lifted to operate on the WRITABILITY OF PARENTS, not just on read-
// only context.

import { Num, type Read, reader, type Val, Vec, type Writable } from "../../index";
import { lensTracked, type LensWOpts } from "./wp-detect";

// ─── numAddP: weight is reactive ────────────────────────────────────

/** `a +ʷ b` where the absorption weight is itself a (possibly reactive)
 *  value. Drag a "split" slider; the lens's split policy changes live. */
export function numAddP(
  a: Writable<Num>,
  b: Writable<Num>,
  weightA: Val<number>,
  opts: LensWOpts = {},
): Writable<Num> {
  const wA = reader(weightA);
  return lensTracked(
    [a, b] as const,
    ([av, bv]) => av + bv,
    (target, [av, bv]) => {
      const wa = wA();
      const wb = 1 - wa;
      const delta = target - (av + bv);
      return [av + delta * wa, bv + delta * wb] as const;
    },
    Num,
    opts,
  );
}

// ─── vecRightP: param absorption is reactive ────────────────────────

/** `a.right(n)` with a reactive split. weight = 0 → a absorbs all (RO
 *  param semantics). weight = 1 → n absorbs all. In between → split. */
export function vecRightP(
  a: Writable<Vec>,
  n: Writable<Num>,
  weight: Val<number>,
  opts: LensWOpts = {},
): Writable<Vec> {
  const w = reader(weight);
  return lensTracked(
    [a, n] as const,
    ([av, nv]) => ({ x: av.x + nv, y: av.y }),
    (target, [av, nv]) => {
      const cur = av.x + nv;
      const dx = target.x - cur;
      const wv = w();
      return [
        { x: av.x + dx * (1 - wv), y: target.y },
        nv + dx * wv,
      ] as const;
    },
    Vec,
    opts,
  );
}

// ─── polarP: policy as a SIGNAL of discrete strings ─────────────────

export type PolarPol = "rotate" | "translate" | "radial" | "circular";

/** Polar with a reactive policy cell. Drag the policy slider/menu; the
 *  bwd switches between the four canonical inverses without rebuilding. */
export function polarP(
  center: Writable<Vec>,
  r: Writable<Num>,
  a: Writable<Num>,
  policy: Val<PolarPol>,
  opts: LensWOpts = {},
): Writable<Vec> {
  const p = reader(policy);
  return lensTracked(
    [center, r, a] as const,
    ([cv, rv, av]) => ({
      x: cv.x + rv * Math.cos(av),
      y: cv.y + rv * Math.sin(av),
    }),
    (target, [cv, rv, av]) => {
      const policyNow = p();
      switch (policyNow) {
        case "rotate": {
          const dx = target.x - cv.x;
          const dy = target.y - cv.y;
          return [undefined, Math.hypot(dx, dy), Math.atan2(dy, dx)] as const;
        }
        case "translate": {
          const fx = cv.x + rv * Math.cos(av);
          const fy = cv.y + rv * Math.sin(av);
          return [
            { x: cv.x + (target.x - fx), y: cv.y + (target.y - fy) },
            undefined,
            undefined,
          ] as const;
        }
        case "radial": {
          const dx = target.x - cv.x;
          const dy = target.y - cv.y;
          return [undefined, dx * Math.cos(av) + dy * Math.sin(av), undefined] as const;
        }
        case "circular": {
          const dx = target.x - cv.x;
          const dy = target.y - cv.y;
          return [undefined, undefined, Math.atan2(dy, dx)] as const;
        }
      }
    },
    Vec,
    opts,
  );
}
