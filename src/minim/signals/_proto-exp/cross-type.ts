// _proto-exp/cross-type.ts — cross-type lens primitive sketch.
//
// `.through(fwd, bwd)` is endo: T → T. The natural extension is
// cross-type: T → U with a wrapper class for U. Call it `.lensTo`.
//
// API: `cell.lensTo(WrapperCls, fwd, bwd)` returns a `WrapperCls`
// instance wrapping a Derived<U> that reads/writes through `cell`.
//
// Question: does this compose cleanly with `.through()` on either side?
//
// Examples we want to enable:
//   - vec.lensTo(Num, v => v.x, (x, v) => ({...v, x}))   // field-lens via lensTo
//   - vec.lensTo(Num, v => Math.hypot(v.x, v.y), ...)   // magnitude (lossy/cyclic)
//   - num.lensTo(Vec, n => ({x: n, y: n}), v => v.x)     // 1D → 2D embedding (lossy)
//   - color.lensTo(Hsl, rgbToHsl, hslToRgb)             // colorspace
//
// Compare to today:
//   - field(k, Cls) is essentially `.lensTo(Cls, v => v[k], (k, v) => {...v, [k]: k})`
//   - lensCls(Cls, g, s) is `signal.lensTo(Cls, g, s)` if signal-is-self
//
// So lensTo unifies field + lensCls into one primitive.

import { Source, Derived } from "../_proto-cell2/cell2";
import { Num4 } from "../_proto-cell4/num4";
import { Vec4, field, memo } from "../_proto-cell4/vec4";

// The "outer source" the cross-type lens reads/writes through.
interface RW<T> {
  value: T;
  peek(): T;
}

/** Cross-type lens construction. Takes a wrapper class for the output
 *  type and (fwd, bwd) functions between value-types.
 *
 *  Returns a fresh wrapper instance whose `value` is `fwd(parent.value)`
 *  and whose writes call `parent.value = bwd(v, parent.peek())`. The
 *  bwd has access to the parent's current value (needed for the spread
 *  pattern in field-lens-style cases). */
function lensTo<S, U, W>(
  parent: RW<S>,
  Wrap: new (cell: Derived<U>) => W,
  fwd: (s: S) => U,
  bwd: (u: U, s: S) => S,
): W {
  return new Wrap(new Derived(
    () => fwd(parent.value),
    (u) => { parent.value = bwd(u, parent.peek()) },
  ));
}

// ─── Example: derive Num magnitude from Vec ────────────────────

/** Vec.magnitude — a cross-type read-only computation, but expressed
 *  via the same lensTo primitive with a noop bwd that throws. */
export function magnitude(v: Vec4): Num4 {
  return memo(v, "magnitude", () => {
    // RO derivative: write throws. Could give it a non-throwing bwd
    // (project the magnitude back to a unit-length vec), but let's
    // keep this one RO.
    return new Num4(new Derived(
      () => { const p = v.value; return Math.hypot(p.x, p.y) },
      () => { throw new TypeError("magnitude is read-only") },
    ));
  });
}

// ─── Example: re-express .x via lensTo (was: field(this, "x", Num4)) ─

/** Reimplement Vec4's .x field lens via the general lensTo. Same
 *  semantics, different framing — shows that field() is a special
 *  case of lensTo for object property access. */
export function lensX(v: Vec4): Num4 {
  return lensTo(
    v, Num4,
    (s) => s.x,
    (x, s) => ({ ...s, x }),
  );
}

// ─── Example: cyclic 1D ↔ 2D embedding ─────────────────────────

/** A weird-but-coherent cross-type lens: read embeds Num n into
 *  Vec (n, n); write projects Vec.x back. Lossy in the bwd direction. */
export function diagonalEmbed(n: Num4): Vec4 {
  return lensTo(
    n, Vec4,
    (s) => ({ x: s, y: s }),
    (v) => v.x,  // project back: take x
  );
}

// ─── Cross-type lens with fusion across .through() ─────────────

/** Demonstrate that you can chain `.through()` after `lensTo` cleanly
 *  in the wrapper of the target type. Since the wrapper's through()
 *  already fuses with prior through()s in the *target* type's space,
 *  the fusion stops at the cross-type boundary — but the algebra is
 *  still composable: `vec.lensTo(Num, fwd, bwd).through(f, g)` works,
 *  with the through-fusion living in the Num4 layer. */

// ─── Test ──────────────────────────────────────────────────────

export { lensTo };

// Sanity tests live in `cross-type.test.ts` next door.
