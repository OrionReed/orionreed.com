// Core primitive: invertible derivation chains.
//
// A `Chain<S, T, W>` is a list of steps that compute `S → T`. Each
// step may be invertible (`Iso<A, B>` with `fwd` + `bwd`) or one-way
// (`Step<A, B>` with `fwd` only). The chain's third type parameter
// `W extends boolean` tracks whether ALL steps are invertible — i.e.
// whether the chain itself is invertible as a whole.
//
// `via(source, chain)` compiles the chain into a reactive node:
//   - `W = true`  → writable `Signal<T>` (writes route bwd through steps)
//   - `W = false` → read-only `Read<T>`  (no setter installed)
//
// The chain itself is plain data. No reactive plumbing in `Iso` /
// `Chain`. The engine integration is contained in `via()`.
//
// MUTABILITY NOTE: `iso()` / `ro()` MUTATE the chain in-place (the
// returned `Chain` is the same instance, retyped). This is safe because
// chains are always built as builders inside a single expression
// (`derive((c) => c.add(b).scale(k))`) and never escape construction.
// The mutation buys substantial construction-time wins (see
// `bench-variants.ts`): ~35% faster, ~36% less memory for 3-step chains.

import {
  Signal,
  type Read,
  computed,
  lens,
} from "../signals/signal";
import { derived } from "../signals/derive";

// ─── Iso / Step ───────────────────────────────────────────────────────

/** Invertible map. `bwd(fwd(s)) === s` and `fwd(bwd(t, _)) === t` when
 *  the laws hold. `prev` is passed for inverses that need upstream state
 *  (e.g. partial-field updates); mark `needsPrev: true` so `via()` knows
 *  to allocate the prev-snapshot array. Arithmetic isos can omit it. */
export interface Iso<S, T> {
  fwd: (s: S) => T;
  bwd: (t: T, prev: S) => S;
  /** Default: false. Pure-arithmetic inverses can skip the prev arg.
   *  Field / partial-update isos need it. */
  needsPrev?: boolean;
}

/** One-way map. `fwd` only. */
export interface Step<S, T> {
  fwd: (s: S) => T;
}

// Internal representation — Chain holds an untyped step list; types
// live entirely on the Chain wrapper.
interface RawStep {
  fwd: (v: unknown) => unknown;
  bwd?: (v: unknown, prev: unknown) => unknown;
  needsPrev?: boolean;
}

// ─── Chain ────────────────────────────────────────────────────────────

/** Composable derivation chain from `S` to `T`. `W` tracks whether
 *  every step in the chain is invertible (`true`) or at least one is
 *  one-way (`false`). `iso()` preserves `W`; `ro()` downgrades to `false`.
 *
 *  Mutability: methods mutate in-place. Treat as a single-use builder. */
export class Chain<S, T, W extends boolean> {
  // Marker fields so TS can't structurally collapse `Chain<S, T, true>`
  // and `Chain<S, T, false>`. Strictly virtual.
  declare readonly __s?: (s: S) => void;
  declare readonly __t?: () => T;
  declare readonly __w?: W;

  /** @internal */
  readonly _steps: RawStep[];
  /** @internal — set when any iso has `needsPrev: true`. */
  _anyNeedsPrev: boolean = false;

  constructor() { this._steps = []; }

  /** Empty chain — identity `S → S`, fully invertible. */
  static of<S>(): Chain<S, S, true> {
    return new Chain<S, S, true>();
  }

  /** Append an invertible step. Preserves the chain's `W` parameter.
   *  Mutates and returns `this` (re-typed). */
  iso<U>(step: Iso<T, U>): Chain<S, U, W> {
    const needs = step.needsPrev === true;
    this._steps.push({
      fwd: step.fwd as RawStep["fwd"],
      bwd: step.bwd as RawStep["bwd"],
      needsPrev: needs,
    });
    if (needs) this._anyNeedsPrev = true;
    return this as unknown as Chain<S, U, W>;
  }

  /** Append a one-way step. Downgrades the chain to read-only. */
  ro<U>(step: Step<T, U>): Chain<S, U, false> {
    this._steps.push({ fwd: step.fwd as RawStep["fwd"] });
    return this as unknown as Chain<S, U, false>;
  }
}

// ─── via: compile chain into a reactive node ──────────────────────────

/** Conditional return type: writable iff `W` is exactly `true`. */
export type ViaResult<T, W extends boolean> = [W] extends [true]
  ? Signal<T>
  : Read<T>;

/** Conditional return when a class is provided: writable iff `W = true`. */
export type ViaTyped<T, W extends boolean, C extends Signal<T>> = [W] extends [true]
  ? C
  : Omit<C, "value"> & Read<T>;

/** Apply a chain to a reactive source. Returns a writable view if every
 *  step is invertible; a read-only view otherwise. */
export function via<S, T, W extends boolean>(
  source: Signal<S>,
  chain: Chain<S, T, W>,
): ViaResult<T, W>;
/** Typed variant: pass `Cls` to make the result `instanceof Cls` (so
 *  chained methods on the value class work — `vec.add(b).distance(c)`). */
export function via<S, T, W extends boolean, C extends Signal<T>>(
  source: Signal<S>,
  chain: Chain<S, T, W>,
  Cls: new (...args: never[]) => C,
): ViaTyped<T, W, C>;
export function via<S, T>(
  source: Signal<S>,
  chain: Chain<S, T, boolean>,
  Cls?: new (...args: never[]) => Signal<T>,
): Signal<T> | Read<T> {
  const steps = chain._steps;
  const n = steps.length;

  // ── Fast path: single-step chain ──
  // Avoid the fwd-reduce loop and the prev[] allocation entirely.
  // This is the common case (every eager method `.add(b)`, `.scale(k)`
  // etc. produces a single-step chain).
  if (n === 1) {
    const s0 = steps[0];
    const f1 = (s: S) => s0.fwd(s) as T;
    if (s0.bwd === undefined) {
      return Cls ? derived(Cls, () => f1(source.value)) : computed(() => f1(source.value));
    }
    const b1 = (t: T): S =>
      s0.bwd!(t, s0.needsPrev ? source.peek() : undefined) as S;
    const setter = (next: T): void => { source.value = b1(next); };
    return Cls
      ? derived(Cls, () => f1(source.value), setter)
      : lens(() => f1(source.value), setter);
  }

  // ── Multi-step / empty ──
  const fwd = (s: S): T => {
    let v: unknown = s;
    for (let i = 0; i < n; i++) v = steps[i].fwd(v);
    return v as T;
  };
  const allInvertible = n === 0 || steps.every((s) => s.bwd !== undefined);
  if (!allInvertible) {
    return Cls
      ? derived(Cls, () => fwd(source.value))
      : computed(() => fwd(source.value));
  }

  // Two bwd variants based on whether ANY step needs `prev`. Most
  // arithmetic chains skip the prev-array allocation entirely.
  const anyNeedsPrev = chain._anyNeedsPrev;
  const bwd = anyNeedsPrev
    ? (t: T): S => {
        const prev = new Array<unknown>(n);
        let v: unknown = source.peek();
        for (let i = 0; i < n; i++) { prev[i] = v; v = steps[i].fwd(v); }
        let cur: unknown = t;
        for (let i = n - 1; i >= 0; i--) cur = steps[i].bwd!(cur, prev[i]);
        return cur as S;
      }
    : (t: T): S => {
        // Pure-arithmetic path: no prev[] allocation; bwds ignore the arg.
        let cur: unknown = t;
        for (let i = n - 1; i >= 0; i--) cur = steps[i].bwd!(cur, undefined);
        return cur as S;
      };

  const setter = (next: T): void => { source.value = bwd(next); };

  return Cls
    ? derived(Cls, () => fwd(source.value), setter)
    : lens(() => fwd(source.value), setter);
}

// ─── Convenience: identity-rooted chain helpers ───────────────────────

/** `S → S` identity chain. Alias for `Chain.of<S>()` at call sites
 *  that read better that way. */
export const start = <S>(): Chain<S, S, true> => Chain.of<S>();
