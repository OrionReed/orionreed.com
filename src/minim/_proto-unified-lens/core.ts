// _proto-unified-lens/core.ts — unified lens/derive surface.
//
// Replaces `through`, `lensTo`, `deriveTo`, `fanin`, closure-style
// `Cls.lens(g, s)`, closure-style `Cls.derive(fn)` with FOUR
// entry points:
//
//   lens(parent | parents, fwd, bwd)        // RW (free)
//   derive(parent | parents, fn)             // RO (free)
//   classLens(Cls, parent | parents, fwd, bwd)  // RW typed; in real
//                                                // surface this is
//                                                // `Cls.lens(...)`
//   classDerive(Cls, parent | parents, fn)      // RO typed; real
//                                                // surface `Cls.derive(...)`
//
// Plus an endo sugar `parent.lens(fwd, bwd)` (rename of `through`).
// In the real migration this would replace `Signal.prototype.through`;
// here we demonstrate via the free `endoLens` wrapper.
//
// Engine integration:
//   - 1-input variants dispatch to `Signal._fuse` → fusion + field-
//     path fast paths intact.
//   - N-input variants dispatch to `Signal.install` with a pre-
//     allocated scratch buffer + arity-based bwd dispatch. Subsumes
//     `fanin` directly.

import { fanin, type Of, type Read, Signal, type Writable } from "../signals";

// ─── Type helpers ────────────────────────────────────────────────

/** Tuple of parent value types. */
type Vals<P extends readonly Read<unknown>[]> = {
  [K in keyof P]: P[K] extends Read<infer V> ? V : never;
};

/** Tuple of optional parent updates (undefined = leave parent alone). */
type Updates<P extends readonly Read<unknown>[]> = {
  [K in keyof P]?: P[K] extends Read<infer V> ? V : never;
};

// biome-ignore lint/suspicious/noExplicitAny: variance escape hatch
type AnyCls<C extends new (...args: never[]) => Signal<any>> = C;

// ─── lens (free function) ────────────────────────────────────────

/** RW lens from one parent. Goes through `Signal._fuse` (gets
 *  fusion, field-path fast path). bwd typed `(t, v) => P`; engine
 *  arity-detects statefulness via `bwd.length`. */
export function lens<P, R>(
  parent: Read<P>,
  fwd: (v: P) => R,
  bwd: (target: R, v: P) => P,
): Writable<Signal<R>>;
/** RW lens from N parents. Subsumes `fanin`. */
export function lens<P extends readonly Read<unknown>[], R>(
  parents: P,
  fwd: (vals: Vals<P>) => R,
  bwd: (target: R, vals: Vals<P>) => Updates<P>,
): Writable<Signal<R>>;
export function lens(parent: unknown, fwd: unknown, bwd: unknown): unknown {
  if (Array.isArray(parent)) {
    return fanin(
      Signal as unknown as new (
        ...args: never[]
      ) => Signal<unknown>,
      parent as never,
      fwd as never,
      bwd as never,
    );
  }
  return Signal._fuse(
    parent as Signal<unknown>,
    Signal as unknown as new (
      ...args: never[]
    ) => Signal<unknown>,
    fwd as (s: unknown) => unknown,
    bwd as (v: unknown, s: unknown) => unknown,
  );
}

// ─── derive (free function) ──────────────────────────────────────

/** RO derived signal from one parent. Goes through `Signal._fuse`. */
export function derive<P, R>(parent: Read<P>, fn: (v: P) => R): Signal<R>;
/** RO derived signal from N parents. */
export function derive<P extends readonly Read<unknown>[], R>(
  parents: P,
  fn: (vals: Vals<P>) => R,
): Signal<R>;
export function derive(parent: unknown, fn: unknown): unknown {
  if (Array.isArray(parent)) {
    return fanin(
      Signal as unknown as new (
        ...args: never[]
      ) => Signal<unknown>,
      parent as never,
      fn as never,
    );
  }
  return Signal._fuse(
    parent as Signal<unknown>,
    Signal as unknown as new (
      ...args: never[]
    ) => Signal<unknown>,
    fn as (s: unknown) => unknown,
  );
}

// ─── Cls.lens / Cls.derive (typed) ───────────────────────────────

/** Typed RW lens from one parent. Real surface: `Cls.lens(parent, fwd, bwd)`.
 *
 *  Type parameters: P (parent value), R (output value), C (class).
 *  R is FREE (not bound to `Of<InstanceType<C>>`) — same pattern as
 *  `fanin`. Users opt into stricter typing via return-type annotation. */
export function classLens<
  P,
  R,
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  C extends new (
    ...args: never[]
  ) => Signal<any>,
>(
  Cls: AnyCls<C>,
  parent: Read<P>,
  fwd: (v: P) => R,
  bwd: (target: R, v: P) => P,
): Writable<InstanceType<C>>;
/** Typed RW lens from N parents. */
export function classLens<
  P extends readonly Read<unknown>[],
  R,
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  C extends new (
    ...args: never[]
  ) => Signal<any>,
>(
  Cls: AnyCls<C>,
  parents: P,
  fwd: (vals: Vals<P>) => R,
  bwd: (target: R, vals: Vals<P>) => Updates<P>,
): Writable<InstanceType<C>>;
export function classLens(
  // biome-ignore lint/suspicious/noExplicitAny: variance
  Cls: new (...args: never[]) => Signal<any>,
  parent: unknown,
  fwd: unknown,
  bwd: unknown,
): unknown {
  if (Array.isArray(parent)) {
    // Delegate to existing `fanin` for N-input. This guarantees perf
    // parity (same monomorphic call site) and avoids re-implementing
    // the scratch+arity-dispatch logic.
    // biome-ignore lint/suspicious/noExplicitAny: variance
    return fanin(Cls as any, parent as never, fwd as never, bwd as never);
  }
  return Signal._fuse(
    parent as Signal<unknown>,
    Cls,
    fwd as (s: unknown) => unknown,
    bwd as (v: unknown, s: unknown) => unknown,
  );
}

/** Typed RO derived signal from one parent. Real surface: `Cls.derive(parent, fn)`. */
export function classDerive<
  P,
  R,
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  C extends new (
    ...args: never[]
  ) => Signal<any>,
>(Cls: AnyCls<C>, parent: Read<P>, fn: (v: P) => R): InstanceType<C>;
/** Typed RO derived signal from N parents. */
export function classDerive<
  P extends readonly Read<unknown>[],
  R,
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  C extends new (
    ...args: never[]
  ) => Signal<any>,
>(Cls: AnyCls<C>, parents: P, fn: (vals: Vals<P>) => R): InstanceType<C>;
export function classDerive(
  // biome-ignore lint/suspicious/noExplicitAny: variance
  Cls: new (...args: never[]) => Signal<any>,
  parent: unknown,
  fn: unknown,
): unknown {
  if (Array.isArray(parent)) {
    // biome-ignore lint/suspicious/noExplicitAny: variance
    return fanin(Cls as any, parent as never, fn as never);
  }
  return Signal._fuse(parent as Signal<unknown>, Cls, fn as (s: unknown) => unknown);
}

// ─── endo: parent.lens(fwd, bwd) ─────────────────────────────────

/** Endo-lens (RW, same class). In real surface this is the
 *  instance method `parent.lens(fwd, bwd)` (rename of `through`). */
export function endoLens<S extends Signal<unknown>>(
  parent: S,
  fwd: (v: Of<S>) => Of<S>,
  bwd: (target: Of<S>, v: Of<S>) => Of<S>,
): S {
  // Equivalent to today's `parent.through(fwd, bwd)`.
  return (parent as Signal<Of<S>>).through(
    fwd as (v: Of<S>) => Of<S>,
    bwd as (v: Of<S>, s: Of<S>) => Of<S>,
  ) as S;
}

// N-input dispatch: delegates to the existing `fanin`. Same engine
// path, same setter shape, perf parity. The new lens API is just
// a different NAME and SHAPE for the same primitive.
