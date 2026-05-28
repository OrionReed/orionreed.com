// lens-params.ts — writable lens-parameter wrappers.
//
// @experimental — all exports are experimental. The brand shapes and
// names may change before promotion to the stable API.
//
// Two flavors, both opt-in. They sit on different points in the
// shared/exclusive × asymmetric/symmetric design space:
//
//   share(sig)  — SHARED writable param. Multiple consumers can read AND
//                 write. The receiving lens absorbs view-writes through
//                 `sig` with a configurable weight; residual flows to the
//                 receiver. Parent edits don't touch sig (asymmetric).
//
//   own(sig)    — OWNED writable param. Single-writer (claimed at
//                 construction); externally read-only (engine throws on
//                 non-owner writes via `_ownerToken`). The receiving lens
//                 routes BOTH view-writes AND parent-edits through `sig`
//                 (symmetric drag-through).
//
// Per value-class integration follows the same pattern in `num.ts`,
// `vec.ts`, etc.: existing methods gain `Share<T> | Own<S>` overloads
// that dispatch to `_*Share` / `_*Own` helpers. The RO path is
// unchanged.

import {
  isSignal,
  type Read,
  type Signal,
  type Val,
  type Writable,
  withinOwner as _withinOwner,
} from "./signal";

// ─── share() — shared writable param ────────────────────────────────

const SHARE_BRAND: unique symbol = Symbol("share.brand");

/** @experimental — per-param options for `share()`. */
export interface ShareOpts {
  /** Relative absorption weight in the bwd's distribution. Default 1.
   *  Reactive: pass a `Val<number>`. */
  weight?: Val<number>;
}

/** @experimental — shared writable lens parameter. Multiple lenses may
 *  consume the same share; external code may read AND write it. */
export interface Share<T> {
  readonly [SHARE_BRAND]: true;
  readonly sig: Writable<Signal<T>>;
  readonly weight: Val<number>;
}

/** @experimental — wrap a writable signal as a SHARED lens parameter.
 *  See module header for semantics. */
export function share<T>(sig: Writable<Signal<T>>, opts?: ShareOpts): Share<T> {
  if (
    !isSignal(sig) ||
    ((sig as Signal<unknown>).getter !== undefined && (sig as Signal<unknown>).setter === undefined)
  ) {
    throw new TypeError("share(): expected a Writable<Signal<T>> (signal or writable lens)");
  }
  return {
    [SHARE_BRAND]: true as const,
    sig,
    weight: opts?.weight ?? 1,
  };
}

/** @experimental — runtime brand check for `share()`. Designed for use
 *  inside method bodies as a discriminant; the inferred `Share<T>`
 *  type carries `T` from the call-site parameter. */
export function isShare<T>(v: Param<T>): v is Extract<Param<T>, Share<T>> {
  return typeof v === "object" && v !== null && (v as { [SHARE_BRAND]?: true })[SHARE_BRAND] === true;
}

// ─── own() — owned writable param ───────────────────────────────────

const OWN_BRAND: unique symbol = Symbol("own.brand");

/** @experimental — owned writable lens parameter. Single-writer; the
 *  first factory that takes it in a writable slot claims it (any
 *  second claim throws). Externally read-only at runtime. The owning
 *  lens routes both view-writes AND parent-edits through this cell
 *  for symmetric residual flow. */
export interface Own<T> {
  readonly [OWN_BRAND]: true;
  readonly sig: Writable<Signal<T>>;
  /** Set on first claim; throws on second. Object identity is the lens
   *  cell the factory produced (used in error messages). */
  _claimedBy?: object;
  /** Token issued at claim; passed to `withinOwner()` so the engine
   *  admits writes from this owner only. */
  _ownerToken?: symbol;
}

/** @experimental — wrap a writable signal as an OWNED lens parameter.
 *  `T` is the inner value type, inferred from the call site. */
export function own<T>(sig: Writable<Signal<T>>): Own<T> {
  return { [OWN_BRAND]: true, sig };
}

/** @experimental — runtime brand check for `own()`. Designed for use
 *  inside method bodies as a discriminant; the inferred `Own<T>`
 *  type carries `T` from the call-site parameter. */
export function isOwn<T>(v: Param<T>): v is Extract<Param<T>, Own<T>> {
  return typeof v === "object" && v !== null && (v as { [OWN_BRAND]?: true })[OWN_BRAND] === true;
}

/** @experimental — single-claim enforcement. Issues an owner token and
 *  installs it on the underlying signal's `_ownerToken` field so the
 *  engine refuses non-owner writes. Throws if already claimed.
 *
 *  @returns the token; factory uses it via `withinOwner()` to thread
 *           write authority through bwd closures and reactions. */
export function claim<T>(
  o: Own<T>,
  claimant: { _ownName?: string },
): symbol {
  if (o._claimedBy !== undefined) {
    const name = (o._claimedBy as { _ownName?: string })._ownName ?? "another lens";
    throw new TypeError(`own(): sink already claimed by ${name}`);
  }
  o._claimedBy = claimant;
  const token = Symbol(claimant._ownName ?? "own.token");
  o._ownerToken = token;
  (o.sig as { _ownerToken?: symbol })._ownerToken = token;
  return token;
}

// ─── Shared parameter type and reader ───────────────────────────────

/** @experimental — permissive parameter type for value-class methods
 *  that accept any of: literal/Val (RO), share() (shared writable),
 *  or own() (single-writer writable). Dispatch via `isShare(p)` /
 *  `isOwn(p)` inside the method; fall through to the RO path
 *  otherwise. */
export type Param<T> = Val<T> | Share<T> | Own<T>;

/** @experimental — resolve a `Param<T>` to a closure that reads its
 *  current value on each call. For wrapped params, reads through the
 *  underlying signal. */
export function paramReader<T>(p: Param<T>): () => T {
  if (isShare(p) || isOwn(p)) {
    const s = (p as { sig: Read<T> }).sig;
    return () => s.value;
  }
  if (isSignal(p)) return () => (p as Read<T>).value;
  return () => p as T;
}

// ─── Re-export from signal for convenience ──────────────────────────

/** @experimental — re-exported from `./signal` for ergonomic access
 *  from `own()` integration code. See `withinOwner` in `signal.ts`. */
export const withinOwner = _withinOwner;
