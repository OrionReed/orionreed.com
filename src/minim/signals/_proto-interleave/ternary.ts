// Ternary signals — three explicit states ("off", "empty", "value").
//
// User asked about "values that are 'active but nothing here, something
// here, not active'." That's three states. The interesting question:
// does giving these three states FIRST-CLASS primitive status unlock
// composition we can't get from Signal<T | undefined> + Signal<boolean>?
//
// Three concrete answers we test here:
//
//   1. Ternary<T> — a tagged-union signal with on/off/value primitives.
//   2. Variant<{...}> — fully general discriminated-union signal.
//      Ternary is just a 3-case Variant.
//   3. PresenceLens — derive presence from a regular Signal<T> via
//      predicate; lift map to preserve presence.

import { Signal, computed, effect, type Read } from "../signal";

// ── Variant 1: Ternary<T> ────────────────────────────────────────

export type TernaryState<T> =
  | { readonly tag: "off" }
  | { readonly tag: "empty" }
  | { readonly tag: "value"; readonly value: T };

const OFF = Object.freeze({ tag: "off" as const });
const EMPTY = Object.freeze({ tag: "empty" as const });

export class Ternary<T> extends Signal<TernaryState<T>> {
  constructor(initial: TernaryState<T> = OFF) {
    super(initial);
  }

  // Convenience constructors.
  static off<T>(): Ternary<T> { return new Ternary<T>(OFF); }
  static empty<T>(): Ternary<T> { return new Ternary<T>(EMPTY); }
  static of<T>(v: T): Ternary<T> { return new Ternary<T>({ tag: "value", value: v }); }

  // Mutators.
  off(): void { this.value = OFF; }
  empty(): void { this.value = EMPTY; }
  set(v: T): void { this.value = { tag: "value", value: v }; }

  // Predicates as derived signals.
  get isOff(): Read<boolean> { return computed(() => this.value.tag === "off"); }
  get isEmpty(): Read<boolean> { return computed(() => this.value.tag === "empty"); }
  get hasValue(): Read<boolean> { return computed(() => this.value.tag === "value"); }
  get isActive(): Read<boolean> { return computed(() => this.value.tag !== "off"); }

  /** Value-or-default — for sites that just want the T. */
  valueOr(fallback: T): Read<T> {
    return computed(() => {
      const s = this.value;
      return s.tag === "value" ? s.value : fallback;
    });
  }

  /** Map preserves state — only the value case is transformed. */
  map<U>(fn: (v: T) => U): Read<TernaryState<U>> {
    return computed<TernaryState<U>>(() => {
      const s = this.value;
      return s.tag === "value" ? { tag: "value", value: fn(s.value) } : s;
    });
  }
}

// ── Variant 2: General Variant<Cases> ────────────────────────────
//
// Same idea but for arbitrary discriminated unions. Ternary is the
// special case Cases = { off: void, empty: void, value: T }.
//
// What this gives us that a plain Signal<Tag | ValueObj> doesn't:
// safer typed match() with required-exhaustiveness, primitive
// per-case predicates as signals, and "switch on the value state"
// reactivity.

export type VariantCase<C> = { readonly [K in keyof C]: { readonly tag: K; readonly value: C[K] } }[keyof C];

export class Variant<Cases extends Record<string, unknown>> extends Signal<VariantCase<Cases>> {
  constructor(initial: VariantCase<Cases>) { super(initial); }

  set<K extends keyof Cases>(tag: K, value: Cases[K]): void {
    this.value = { tag, value } as VariantCase<Cases>;
  }

  /** Reactive view: is the variant currently in case `k`? */
  is<K extends keyof Cases>(k: K): Read<boolean> {
    return computed(() => this.value.tag === k);
  }

  /** Pattern-match → a derived signal of `R`. Object syntax keeps the
   *  cases visible at the call site. */
  match<R>(handlers: { [K in keyof Cases]: (v: Cases[K]) => R }): Read<R> {
    return computed<R>(() => {
      const v = this.value;
      const h = handlers[v.tag as keyof Cases] as (val: unknown) => R;
      return h(v.value);
    });
  }
}

// ── Variant 3: PresenceLens — presence from a plain signal ───────
//
// What if we don't need a new value class at all? Take any signal,
// pair it with a "is-active" predicate, and you have presence-aware
// derivation. The output is a tuple of (active, value). Operations
// that need to short-circuit on "off" can check active first.

export interface Present<T> {
  active: Read<boolean>;
  value: Read<T>;  // undefined behaviour when active is false; consumer must check.
}

export const present = <T>(s: Read<T>, isOn: Read<boolean>): Present<T> => ({
  active: isOn,
  value: s,
});

/** Project Present<T> to T | null, where null encodes "off." */
export const collapse = <T>(p: Present<T>): Read<T | null> =>
  computed(() => (p.active.value ? p.value.value : null));
