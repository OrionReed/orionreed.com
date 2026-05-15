// ── Exploration: collapse `defaults` + `nested` into `fields` ────────
//
// Hypothesis: the split between `defaults` (the value shape) and
// `nested` (per-field types) is historical, not necessary. Both can
// be expressed in one declaration where:
//
//   field: Vec                  → typed with Vec's defaults
//   field: 0                    → primitive default (no type)
//   field: { type: Vec, init: {x: 50, y: 50} }    → typed with override
//
// This file just defines value types in both styles side by side
// to compare readability + verbosity. Not wired up; purely exploration.

import { struct, type Type } from "./cell";

// ─────────────────────────────────────────────────────────────────────
// Current style — `defaults` + separate `nested:` map
// ─────────────────────────────────────────────────────────────────────

interface V_curr { x: number; y: number }
interface Tr_curr {
  translate: V_curr; rotate: number; scale: V_curr; origin: V_curr; opacity: number;
}

const Num_curr = struct({
  name: "Num",
  defaults: 0 as number,
  lerp: (a, b, t) => a + (b - a) * t,
  linear: { add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k },
  metric: (a, b) => Math.abs(a - b),
});

const Vec_curr = struct({
  name: "Vec",
  defaults: { x: 0, y: 0 } as V_curr,
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  linear: {
    add:   (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  },
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
});

const Transform_curr = struct({
  name: "Transform",
  defaults: {
    translate: { x: 0, y: 0 }, rotate: 0,
    scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
  } as Tr_curr,
  nested: {
    translate: Vec_curr, scale: Vec_curr, origin: Vec_curr,
    rotate: Num_curr, opacity: Num_curr,
  },
  storage: "soa",
});

// ─────────────────────────────────────────────────────────────────────
// Proposed style — `fields` config (no separate `defaults` or `nested`)
// ─────────────────────────────────────────────────────────────────────
//
// Hypothetical `structF()` factory (not implemented; sketch only).
// The factory walks `fields`:
//   • Plain value     → field has primitive default, no type
//   • Type<X>         → field is typed X, default = X.defaults
//   • { type, init }  → field is typed, default = init
//
// Then it synthesises:
//   defaults  = walking fields, picking value or Type.defaults
//   nested    = walking fields, picking Type entries
// internally — user never writes either.

// For a primitive type (Num) — no `fields` makes sense; use `default`:
//
//   structF({
//     name: "Num",
//     default: 0,
//     ...capabilities
//   });
//
// For an object type (Vec) — `fields` with primitive values:
//
//   structF({
//     name: "Vec",
//     fields: { x: 0, y: 0 },
//     ...capabilities
//   });
//
// For a composite (Transform) — `fields` with Types and primitives mixed:
//
//   structF({
//     name: "Transform",
//     fields: {
//       translate: Vec,                                        // typed shorthand
//       scale: { type: Vec, init: { x: 1, y: 1 } },            // typed with init override
//       origin: Vec,
//       rotate: Num,
//       opacity: { type: Num, init: 1 },                       // override default 0
//     },
//     storage: "soa",
//   });
//
// Compare:

// ─────────────────────────────────────────────────────────────────────
// LINE BY LINE COMPARISON
// ─────────────────────────────────────────────────────────────────────
//
// CURRENT Vec (10 LOC):
//
//   const Vec = struct({
//     name: "Vec",
//     defaults: { x: 0, y: 0 } as V,
//     lerp, linear, metric, ...
//   });
//
// PROPOSED Vec (10 LOC):
//
//   const Vec = struct({
//     name: "Vec",
//     fields: { x: 0, y: 0 },        // no `as V` cast needed if inferred
//     lerp, linear, metric, ...
//   });
//
// Almost identical. Marginally cleaner (no `as V` ceremony).
//
//
// CURRENT Transform (13 LOC):
//
//   const Transform = struct({
//     name: "Transform",
//     defaults: {
//       translate: { x: 0, y: 0 }, rotate: 0,
//       scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
//     } as Tr,
//     nested: {
//       translate: Vec, scale: Vec, origin: Vec,
//       rotate: Num, opacity: Num,
//     },
//     storage: "soa",
//   });
//
// PROPOSED Transform (9 LOC):
//
//   const Transform = struct({
//     name: "Transform",
//     fields: {
//       translate: Vec, scale: Vec, origin: Vec,    // implicit defaults
//       rotate: Num,
//       opacity: { type: Num, init: 1 },             // override the 0 default
//     },
//     storage: "soa",
//   });
//
// 30% shorter, ONE field-shape declaration. No duplication between
// `defaults` and `nested`. The Tr interface is still needed for
// consumer code (`function rotate(tr: Cell<Tr>)`), but the struct
// config doesn't restate the shape.

// ─────────────────────────────────────────────────────────────────────
// COSTS
// ─────────────────────────────────────────────────────────────────────
//
// 1. TYPE-LEVEL: deriving T from `fields` is harder. With `defaults: { x: 0, y: 0 } as V`
//    we directly extract `T = V`. With `fields: { translate: Vec, rotate: Num }`,
//    `T = { translate: V; rotate: number }` must be reconstructed:
//
//      type ExtractT<C> = C extends { fields: infer F }
//        ? { [K in keyof F]: F[K] extends Type<infer X> ? X
//                          : F[K] extends { type: Type<infer X> } ? X
//                          : F[K] }
//        : never;
//
//    Two recursive checks per field. TS will be slower-to-infer; may
//    hit instantiation limits for big structs.
//
// 2. RUNTIME: marginally more code in the framework to walk `fields`,
//    extract defaults, extract types. ~30 LOC of synthesis. Same total
//    LOC; just shifted.
//
// 3. MIGRATION: every value-type file needs rewriting. Manageable but
//    real.
//
// 4. FAMILIARITY: `defaults` is the standard term in struct/record
//    libraries (Immer, Immutable.js, etc). `fields` is also standard.
//    Roughly equivalent.

// ─────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────
//
// `fields` collapse looks like a net win:
//
//   + Transform definitions get 30-40% shorter.
//   + One config shape, no duplication between `defaults` and `nested`.
//   + Removes the awkward `as Tr` casts (TS infers from field config).
//   + The `nested` concept disappears from user vocabulary.
//   - Type-level inference is harder (recursive `ExtractT<C>` walker).
//   - Migration cost.
//   - Primitive types (Num) need a separate `default:` config key.
//
// Worth implementing as a v3 prototype to validate.

// Touch the consts so unused-var doesn't fire.
void Num_curr; void Vec_curr; void Transform_curr;

// Type sketch of what ExtractT<C> would look like for the new shape:
type ExtractFieldType<F> =
  F extends Type<infer X, any> ? X
  : F extends { type: Type<infer X, any> } ? X
  : F;

type ExtractFromFields<C> = C extends { fields: infer F }
  ? { [K in keyof F]: ExtractFieldType<F[K]> }
  : C extends { default: infer D } ? D
  : never;

// Sanity check the type math:
type _CheckVec = ExtractFromFields<{ fields: { x: number; y: number } }>;
type _CheckTr = ExtractFromFields<{
  fields: {
    translate: typeof Vec_curr;
    rotate: typeof Num_curr;
    opacity: { type: typeof Num_curr; init: number };
  };
}>;

// Both should resolve to the right plain types — confirm at the type
// level. (TS hover would show: `{translate: V_curr, rotate: number, opacity: number}`.)
const _check1: _CheckVec = { x: 0, y: 0 };
const _check2: _CheckTr = { translate: { x: 0, y: 0 }, rotate: 0, opacity: 1 };
void _check1; void _check2;

console.log("explore-fields type-level check compiled.");
