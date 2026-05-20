// Perf design variants — each implements the same Chain/via surface
// but with different allocation strategies. Used by `bench-variants.ts`
// to characterize the trade-off space.
//
// V0 baseline = `./iso.ts` (immutable Chain, per-step alloc).
//
// V1 = mutable chain (steps pushed onto the same array, no spread).
//      Loses true immutability — chain becomes effectively single-use
//      since downstream consumers share mutation surface. For an API
//      that's a builder (`.add().scale().sub()` chained inline) the
//      shared-mutation problem is moot.
//
// V2 = no Chain wrapper. The "chain" is just an array of steps,
//      built in-place. via() takes the array directly. Authors write
//      isos as data, push onto a local array, hand it off.
//
// V3 = "single-step" fast path in via(). If the chain is length 1,
//      no fwd-reduce loop, no prev array; just call fwd(source.value)
//      and the single bwd directly.
//
// V4 = "no prev allocation" — only allocate the prev array when at
//      least one step's bwd actually uses it (most arithmetic doesn't).
//
// V5 = pooled empty Chain (constant). One shared instance for Chain.of.

import {
  Signal,
  type Read,
  computed,
  lens,
} from "../signals/signal";
import { derived } from "../signals/derive";

// ─── Shared types ─────────────────────────────────────────────────────

export interface Iso<S, T> {
  fwd: (s: S) => T;
  bwd: (t: T, prev: S) => S;
}
export interface Step<S, T> { fwd: (s: S) => T }

interface RawStep {
  fwd: (v: unknown) => unknown;
  bwd?: (v: unknown, prev: unknown) => unknown;
  /** v4 hint: does bwd need the `prev` arg? Arithmetic doesn't. */
  needsPrev?: boolean;
}

// ─── V1: mutable chain (no array spread per step) ─────────────────────

export class ChainV1<S, T, W extends boolean> {
  declare readonly __s?: (s: S) => void;
  declare readonly __t?: () => T;
  declare readonly __w?: W;
  readonly _steps: RawStep[];

  /** @internal */
  constructor(steps: RawStep[] = []) { this._steps = steps; }

  static of<S>(): ChainV1<S, S, true> {
    return new ChainV1<S, S, true>([]);
  }

  iso<U>(step: Iso<T, U>): ChainV1<S, U, W> {
    this._steps.push({
      fwd: step.fwd as RawStep["fwd"],
      bwd: step.bwd as RawStep["bwd"],
    });
    return this as unknown as ChainV1<S, U, W>;
  }

  ro<U>(step: Step<T, U>): ChainV1<S, U, false> {
    this._steps.push({ fwd: step.fwd as RawStep["fwd"] });
    return this as unknown as ChainV1<S, U, false>;
  }
}

export function viaV1<S, T, W extends boolean, C extends Signal<T>>(
  source: Signal<S>,
  chain: ChainV1<S, T, W>,
  Cls?: new (...args: never[]) => C,
): Signal<T> | Read<T> {
  const steps = chain._steps;
  const fwd = (s: S): T => {
    let v: unknown = s;
    for (let i = 0; i < steps.length; i++) v = steps[i].fwd(v);
    return v as T;
  };
  const allInvertible = steps.length === 0 || steps.every((s) => s.bwd !== undefined);
  if (!allInvertible) {
    return Cls ? derived(Cls, () => fwd(source.value)) : computed(() => fwd(source.value));
  }
  const bwd = (t: T): S => {
    const prev = new Array<unknown>(steps.length);
    let v: unknown = source.peek();
    for (let i = 0; i < steps.length; i++) {
      prev[i] = v;
      v = steps[i].fwd(v);
    }
    let cur: unknown = t;
    for (let i = steps.length - 1; i >= 0; i--) cur = steps[i].bwd!(cur, prev[i]);
    return cur as S;
  };
  const setter = (next: T): void => { source.value = bwd(next); };
  return Cls ? derived(Cls, () => fwd(source.value), setter) : lens(() => fwd(source.value), setter);
}

// ─── V2: no Chain wrapper, raw array ──────────────────────────────────

/** "Chain" is just an array of steps with a phantom-type wrapper for `W`. */
export type ChainArrV2<S, T, W extends boolean> = RawStep[] & {
  readonly __s?: (s: S) => void;
  readonly __t?: () => T;
  readonly __w?: W;
};

export const v2 = {
  of<S>(): ChainArrV2<S, S, true> { return [] as ChainArrV2<S, S, true>; },
  iso<S, T, U, W extends boolean>(
    c: ChainArrV2<S, T, W>,
    step: Iso<T, U>,
  ): ChainArrV2<S, U, W> {
    c.push({ fwd: step.fwd as RawStep["fwd"], bwd: step.bwd as RawStep["bwd"] });
    return c as unknown as ChainArrV2<S, U, W>;
  },
  ro<S, T, U, W extends boolean>(
    c: ChainArrV2<S, T, W>,
    step: Step<T, U>,
  ): ChainArrV2<S, U, false> {
    c.push({ fwd: step.fwd as RawStep["fwd"] });
    return c as unknown as ChainArrV2<S, U, false>;
  },
};

export function viaV2<S, T, W extends boolean, C extends Signal<T>>(
  source: Signal<S>,
  steps: ChainArrV2<S, T, W>,
  Cls?: new (...args: never[]) => C,
): Signal<T> | Read<T> {
  const fwd = (s: S): T => {
    let v: unknown = s;
    for (let i = 0; i < steps.length; i++) v = steps[i].fwd(v);
    return v as T;
  };
  const allInvertible = steps.length === 0 || steps.every((s) => s.bwd !== undefined);
  if (!allInvertible) {
    return Cls ? derived(Cls, () => fwd(source.value)) : computed(() => fwd(source.value));
  }
  const bwd = (t: T): S => {
    const prev = new Array<unknown>(steps.length);
    let v: unknown = source.peek();
    for (let i = 0; i < steps.length; i++) { prev[i] = v; v = steps[i].fwd(v); }
    let cur: unknown = t;
    for (let i = steps.length - 1; i >= 0; i--) cur = steps[i].bwd!(cur, prev[i]);
    return cur as S;
  };
  const setter = (next: T): void => { source.value = bwd(next); };
  return Cls ? derived(Cls, () => fwd(source.value), setter) : lens(() => fwd(source.value), setter);
}

// ─── V3: single-step fast path in via() (still V1 chain underneath) ───

export function viaV3<S, T, W extends boolean, C extends Signal<T>>(
  source: Signal<S>,
  chain: ChainV1<S, T, W>,
  Cls?: new (...args: never[]) => C,
): Signal<T> | Read<T> {
  const steps = chain._steps;
  // Empty chain — identity. (Skip the loop overhead.)
  if (steps.length === 0) {
    if (Cls) return derived(Cls, () => source.value as unknown as T, (t) => { source.value = t as unknown as S; });
    return lens(() => source.value as unknown as T, (t) => { source.value = t as unknown as S; });
  }
  // Length-1 fast path — skip the fwd-reduce loop and prev-array alloc.
  if (steps.length === 1) {
    const s0 = steps[0];
    const fwdSingle = (s: S) => s0.fwd(s) as T;
    if (s0.bwd === undefined) {
      return Cls ? derived(Cls, () => fwdSingle(source.value)) : computed(() => fwdSingle(source.value));
    }
    const bwdSingle = (t: T): S => s0.bwd!(t, source.peek()) as S;
    const setter = (next: T): void => { source.value = bwdSingle(next); };
    return Cls ? derived(Cls, () => fwdSingle(source.value), setter) : lens(() => fwdSingle(source.value), setter);
  }
  // Multi-step — same as V1.
  const fwd = (s: S): T => {
    let v: unknown = s;
    for (let i = 0; i < steps.length; i++) v = steps[i].fwd(v);
    return v as T;
  };
  const allInvertible = steps.every((s) => s.bwd !== undefined);
  if (!allInvertible) {
    return Cls ? derived(Cls, () => fwd(source.value)) : computed(() => fwd(source.value));
  }
  const bwd = (t: T): S => {
    const prev = new Array<unknown>(steps.length);
    let v: unknown = source.peek();
    for (let i = 0; i < steps.length; i++) { prev[i] = v; v = steps[i].fwd(v); }
    let cur: unknown = t;
    for (let i = steps.length - 1; i >= 0; i--) cur = steps[i].bwd!(cur, prev[i]);
    return cur as S;
  };
  const setter = (next: T): void => { source.value = bwd(next); };
  return Cls ? derived(Cls, () => fwd(source.value), setter) : lens(() => fwd(source.value), setter);
}

// ─── V4: skip prev[] when no step needs it ────────────────────────────

/** Mark a step as needing the `prev` arg in bwd. Authors annotate to
 *  skip the prev-array allocation for arithmetic-only chains. */
export interface IsoMaybePrev<S, T> extends Iso<S, T> { needsPrev?: boolean }

export class ChainV4<S, T, W extends boolean> {
  declare readonly __s?: (s: S) => void;
  declare readonly __t?: () => T;
  declare readonly __w?: W;
  readonly _steps: RawStep[];
  /** OR of step.needsPrev across the chain. */
  _anyNeedsPrev: boolean = false;

  constructor(steps: RawStep[] = []) { this._steps = steps; }

  static of<S>(): ChainV4<S, S, true> {
    return new ChainV4<S, S, true>([]);
  }

  iso<U>(step: IsoMaybePrev<T, U>): ChainV4<S, U, W> {
    const needs = step.needsPrev === true;
    this._steps.push({
      fwd: step.fwd as RawStep["fwd"],
      bwd: step.bwd as RawStep["bwd"],
      needsPrev: needs,
    });
    if (needs) this._anyNeedsPrev = true;
    return this as unknown as ChainV4<S, U, W>;
  }
  ro<U>(step: Step<T, U>): ChainV4<S, U, false> {
    this._steps.push({ fwd: step.fwd as RawStep["fwd"] });
    return this as unknown as ChainV4<S, U, false>;
  }
}

export function viaV4<S, T, W extends boolean, C extends Signal<T>>(
  source: Signal<S>,
  chain: ChainV4<S, T, W>,
  Cls?: new (...args: never[]) => C,
): Signal<T> | Read<T> {
  const steps = chain._steps;
  const anyNeedsPrev = chain._anyNeedsPrev;
  const fwd = (s: S): T => {
    let v: unknown = s;
    for (let i = 0; i < steps.length; i++) v = steps[i].fwd(v);
    return v as T;
  };
  const allInvertible = steps.length === 0 || steps.every((s) => s.bwd !== undefined);
  if (!allInvertible) {
    return Cls ? derived(Cls, () => fwd(source.value)) : computed(() => fwd(source.value));
  }
  // Two bwd paths: if no step needs prev, skip the alloc + the prev[]
  // bookkeeping loop entirely.
  const bwd = anyNeedsPrev
    ? (t: T): S => {
        const prev = new Array<unknown>(steps.length);
        let v: unknown = source.peek();
        for (let i = 0; i < steps.length; i++) { prev[i] = v; v = steps[i].fwd(v); }
        let cur: unknown = t;
        for (let i = steps.length - 1; i >= 0; i--) cur = steps[i].bwd!(cur, prev[i]);
        return cur as S;
      }
    : (t: T): S => {
        // Pure-arithmetic path: just chain the bwds in reverse.
        // We pass undefined as the prev — those bwds ignore it.
        let cur: unknown = t;
        for (let i = steps.length - 1; i >= 0; i--) cur = steps[i].bwd!(cur, undefined);
        return cur as S;
      };
  const setter = (next: T): void => { source.value = bwd(next); };
  return Cls ? derived(Cls, () => fwd(source.value), setter) : lens(() => fwd(source.value), setter);
}

// ─── V5: V1 + V3 + V4 + V2 (best of all) ──────────────────────────────

export class ChainV5<S, T, W extends boolean> {
  declare readonly __s?: (s: S) => void;
  declare readonly __t?: () => T;
  declare readonly __w?: W;
  _steps: RawStep[];
  _anyNeedsPrev: boolean = false;

  constructor() { this._steps = []; }

  static of<S>(): ChainV5<S, S, true> {
    // Note: we can't pool because each chain is mutable. But the empty
    // shape is cheap (1 alloc, 1 empty array).
    return new ChainV5<S, S, true>();
  }

  iso<U>(step: IsoMaybePrev<T, U>): ChainV5<S, U, W> {
    const needs = step.needsPrev === true;
    this._steps.push({
      fwd: step.fwd as RawStep["fwd"],
      bwd: step.bwd as RawStep["bwd"],
      needsPrev: needs,
    });
    if (needs) this._anyNeedsPrev = true;
    return this as unknown as ChainV5<S, U, W>;
  }
  ro<U>(step: Step<T, U>): ChainV5<S, U, false> {
    this._steps.push({ fwd: step.fwd as RawStep["fwd"] });
    return this as unknown as ChainV5<S, U, false>;
  }
}

export function viaV5<S, T, W extends boolean, C extends Signal<T>>(
  source: Signal<S>,
  chain: ChainV5<S, T, W>,
  Cls?: new (...args: never[]) => C,
): Signal<T> | Read<T> {
  const steps = chain._steps;
  const n = steps.length;

  // Single-step fast path — no fwd-reduce, no prev[].
  if (n === 1) {
    const s0 = steps[0];
    if (s0.bwd === undefined) {
      const f1 = (s: S) => s0.fwd(s) as T;
      return Cls ? derived(Cls, () => f1(source.value)) : computed(() => f1(source.value));
    }
    const f1 = (s: S) => s0.fwd(s) as T;
    const b1 = (t: T): S => s0.bwd!(t, s0.needsPrev ? source.peek() : undefined) as S;
    const setter = (next: T): void => { source.value = b1(next); };
    return Cls ? derived(Cls, () => f1(source.value), setter) : lens(() => f1(source.value), setter);
  }

  // Multi-step (or empty)
  const fwd = (s: S): T => {
    let v: unknown = s;
    for (let i = 0; i < n; i++) v = steps[i].fwd(v);
    return v as T;
  };
  const allInvertible = n === 0 || steps.every((s) => s.bwd !== undefined);
  if (!allInvertible) {
    return Cls ? derived(Cls, () => fwd(source.value)) : computed(() => fwd(source.value));
  }
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
        let cur: unknown = t;
        for (let i = n - 1; i >= 0; i--) cur = steps[i].bwd!(cur, undefined);
        return cur as S;
      };
  const setter = (next: T): void => { source.value = bwd(next); };
  return Cls ? derived(Cls, () => fwd(source.value), setter) : lens(() => fwd(source.value), setter);
}

// ─── V6: NumChain *extends* Chain (no per-step wrapper allocation) ────
//
// In V1-V5, every `.add(b)` allocates BOTH a per-value-type wrapper
// (NumChain) AND a Chain. V6 collapses these: the per-value-type chain
// IS a Chain subclass. Per step: 0 allocations (mutates `this`).

export class NumChainV6<W extends boolean> extends ChainV5<unknown, number, W> {
  static start(): NumChainV6<true> {
    return new NumChainV6<true>();
  }
  add(b: number): NumChainV6<W> {
    this.iso({ fwd: (v) => v + b, bwd: (v) => v - b });
    return this as NumChainV6<W>;
  }
  scale(k: number): NumChainV6<W> {
    this.iso({ fwd: (v) => v * k, bwd: (v) => v / k });
    return this as NumChainV6<W>;
  }
  sub(b: number): NumChainV6<W> {
    this.iso({ fwd: (v) => v - b, bwd: (v) => v + b });
    return this as NumChainV6<W>;
  }
}
