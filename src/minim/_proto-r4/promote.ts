// promote.ts — type-level writable lifting.
//
// `Promote<R, InvMethods>` turns a value class `R` into its writable
// form by:
//   - Re-emitting `value`/`set`/`bind` as writable surface (from the
//     `Writers<T>` mixin).
//   - Auto-detecting field-lens properties (any prop typed as a
//     `Signal<unknown>` subclass) and recursively lifting them via a
//     `LiftField` dispatch table.
//   - Lifting the return type of `InvMethods` (invertible eager
//     methods) so chained invertibles stay writable.
//
// Author cost per value class: one type alias like
//   `type WritableVec = Promote<Vec, "add" | "sub" | "scale" | "offset">`
// No subclass declarations, no Object.assign, no method duplication.

import { Signal, type Read } from "./signal";
import { Num } from "./values/num";
import { Vec } from "./values/vec";

/** Writable surface — added by Promote on top of value-class types. */
export interface Writers<T> {
  value: T;
  set(v: T): unknown;
  bind(s: T | (() => T)): () => void;
}

/** Public sugar — "any writable shape over T".
 *
 *  Note: at the structural-check level (e.g. animator parameters),
 *  TS-merge-overridden read-only `value` accessors don't fully strip
 *  the inherited Signal setter. So a bare `Vec` may still satisfy
 *  `Writable<V>` structurally, even though direct `.value = ...` is
 *  caught. Callers wanting strict RO rejection should type-annotate
 *  with `WritableVec` / `WritableNum` (Promote-lifted) and rely on
 *  the factory return types. */
export type Writable<T = unknown> = Signal<T> & Writers<T>;

/** Pick keys whose value is a Read<unknown> (covariant) — i.e. a
 *  field lens. We use Read instead of Signal so the filter doesn't
 *  trip over Signal's invariance in T. */
type LensFields<R> = {
  [K in keyof R]: R[K] extends Read<unknown> ? K : never;
}[keyof R];

/** Dispatch table: map each base value class to its writable form. */
type LiftField<X> =
    X extends Num ? WritableNum
  : X extends Vec ? WritableVec
  : X extends Read<infer T> ? Read<T> & Writers<T>
  : X;

/** Lift a value class R to its writable form. */
export type Promote<R, Inv extends keyof R> =
  Omit<R, Inv | "value" | LensFields<R>>
  & Writers<R extends Signal<infer T> ? T : never>
  & {
      [K in Inv]: R[K] extends (...a: infer A) => R
        ? (...a: A) => Promote<R, Inv>
        : R[K];
    }
  & {
      [K in LensFields<R>]: LiftField<R[K]>;
    };

// Re-export common writable forms for direct import-friendliness.
// (Num/Vec extend Signal<V> for concrete V; relax Promote's constraint
// at the call sites via the `as` cast — the helper is generic over any
// Signal-extending class.)
export type WritableNum = Promote<Num, "add" | "sub" | "scale">;
export type WritableVec = Promote<Vec, "add" | "sub" | "scale" | "offset">;
