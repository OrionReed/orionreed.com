// claim() — fluent builder over `latch` + the predicate library.
//
//   claim(sig, "α").stays.in([0, 1]).during(intro)
//
// The returned `Claim` is a `Read<boolean>` plus `.and` / `.or` /
// `.not` / `.during` / `.labelled` / `.pred` (the raw predicate).

import type { Box, Vec } from "@minim/signals";
import { derive, type Inner, type Read } from "@minim/signals";

import { intervals, latch, type Scope } from "./algebra";
import { above, below, equal, following, inRange, inside, isEqual, near } from "./predicates";

/** Fluent claim — a labeled bool signal with the algebra. */
export interface Claim extends Read<boolean> {
  readonly label?: string;
  /** The raw predicate (pre-latching), useful for custom `latch()` shapes. */
  readonly pred: Read<boolean>;
  and(other: Read<boolean>): Claim;
  or(other: Read<boolean>): Claim;
  not(): Claim;
  during(scope: Scope): Claim;
  labelled(name: string): Claim;
}

type Mood = "stays" | "becomes" | "never";

/** Entry point: `claim(sig).stays.in([0,1])`. `label` flows into
 *  sub-clause failure messages. */
export function claim<T>(sig: Read<T>, label?: string): SignalClaim<T> {
  return {
    sig,
    label,
    get stays() {
      return predicates(sig, "stays", label);
    },
    get becomes() {
      return predicates(sig, "becomes", label);
    },
    get never() {
      return predicates(sig, "never", label);
    },
  };
}

/** Mood selector. */
export interface SignalClaim<T> {
  readonly sig: Read<T>;
  readonly label?: string;
  readonly stays: Predicates<T>;
  readonly becomes: Predicates<T>;
  readonly never: Predicates<T>;
}

/** Predicate vocabulary; numeric/vector preds narrow via `this:`. */
export interface Predicates<T> {
  satisfies(fn: (v: T) => boolean, label?: string): Claim;
  equal(v: T): Claim;
  isEqual(other: Read<T>): Claim;

  in(this: Predicates<number>, range: readonly [number, number]): Claim;
  above(this: Predicates<number>, n: number): Claim;
  below(this: Predicates<number>, n: number): Claim;
  near(this: Predicates<number>, n: number, tol?: number): Claim;
  following(this: Predicates<number>, other: Read<number>, tol?: number): Claim;
  inside(this: Predicates<Inner<Vec>>, region: Box): Claim;

  /** True/false predicates — for moods over already-bool signals. */
  true(this: Predicates<boolean>): Claim;
  false(this: Predicates<boolean>): Claim;
}

function predicates<T>(sig: Read<T>, mood: Mood, lbl: string | undefined): Predicates<T> {
  const build = (pred: Read<boolean>, what: string): Claim => {
    const label = `${lbl ?? "cell"} ${mood} ${what}`;
    // "never": operative predicate is `¬pred`. Carry operative predicate
    // and init through to `during()`.
    switch (mood) {
      case "stays":
        return makeClaim(pred, latch(pred, true), true, label);
      case "never": {
        const negated = derive(() => !pred.value);
        return makeClaim(negated, latch(negated, true), true, label);
      }
      case "becomes":
        return makeClaim(pred, latch(pred, false), false, label);
    }
  };

  return {
    satisfies: (fn, what = "predicate") =>
      build(
        derive(() => fn(sig.value)),
        what,
      ),
    equal: v => build(equal(sig, v), `= ${fmt(v)}`),
    isEqual: other => build(isEqual(sig, other), `= other`),
    in(range: readonly [number, number]) {
      return build(inRange(sig as unknown as Read<number>, range), `∈ [${range[0]}, ${range[1]}]`);
    },
    above(n: number) {
      return build(above(sig as unknown as Read<number>, n), `> ${n}`);
    },
    below(n: number) {
      return build(below(sig as unknown as Read<number>, n), `< ${n}`);
    },
    near(n: number, tol?: number) {
      return build(near(sig as unknown as Read<number>, n, tol), `≈ ${n}`);
    },
    following(other: Read<number>, tol?: number) {
      return build(following(sig as unknown as Read<number>, other, tol), `≈ other`);
    },
    inside(region: Box) {
      return build(inside(sig as unknown as Read<Inner<Vec>>, region), `inside`);
    },
    true: () => build(sig as unknown as Read<boolean>, `= true`),
    false: () =>
      build(
        derive(() => !(sig as unknown as Read<boolean>).value),
        `= false`,
      ),
  } as Predicates<T>;
}

/** Wrap (predicate, latched-signal, init, label) into a Claim. `init`
 *  (true for stays/never, false for becomes) is kept so `.during()`
 *  can rebuild the latch; `pred` is the operative (mood-applied) predicate. */
function makeClaim(
  pred: Read<boolean>,
  latched: Read<boolean>,
  init: boolean,
  label: string,
): Claim {
  return wrapClaim(pred, latched, init, label);
}

function wrapClaim(pred: Read<boolean>, body: Read<boolean>, init: boolean, label: string): Claim {
  return {
    get value() {
      return body.value;
    },
    peek() {
      return body.peek();
    },
    label,
    pred,
    and(other) {
      const next = derive(() => body.value && other.value);
      const otherLabel = (other as { label?: string }).label;
      return wrapClaim(pred, next, init, `${label} ∧ ${otherLabel ?? "?"}`);
    },
    or(other) {
      const next = derive(() => body.value || other.value);
      const otherLabel = (other as { label?: string }).label;
      return wrapClaim(pred, next, init, `${label} ∨ ${otherLabel ?? "?"}`);
    },
    not() {
      // Flipping init too swaps invariant ↔ liveness.
      return wrapClaim(
        pred,
        derive(() => !body.value),
        !init,
        `¬(${label})`,
      );
    },
    during(scope) {
      const sc = intervals(scope);
      // Rebuild the latch with the scope so it auto-rearms on each rising
      // edge. Outside the scope the claim is vacuously satisfied.
      const next = latch(pred, init, sc);
      const gated =
        init === true
          ? derive(() => !sc.value || next.value)
          : derive(() => sc.value && next.value);
      return wrapClaim(pred, gated, init, `(${label}) during ${scopeName(scope)}`);
    },
    labelled(name) {
      return wrapClaim(pred, body, init, name);
    },
  };
}

function scopeName(s: Scope): string {
  if (typeof s === "function") return s.name || "fn";
  if (typeof s === "object" && s !== null && "name" in (s as object)) {
    return (s as { name?: string }).name ?? "span";
  }
  return "scope";
}

function fmt(v: unknown): string {
  if (typeof v === "number") return String(+v.toFixed(6));
  if (typeof v === "string") return JSON.stringify(v);
  if (v && typeof v === "object" && "x" in v && "y" in v) {
    const p = v as { x: number; y: number };
    return `(${fmt(p.x)}, ${fmt(p.y)})`;
  }
  return String(v);
}
