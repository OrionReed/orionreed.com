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
  batch,
  isSignal,
  network,
  type Read,
  reader,
  Signal,
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

// ─── lensWithParam — the unifying primitive ─────────────────────────
//
// @experimental — the substrate-level helper that consumes a small
// algebra spec (fwd + solveA + solveP) and emits the correct lens cell
// for whatever flavor of param it sees (RO / share / own). Value-class
// methods like `Num.add` / `Vec.right` / `Box.scale` reduce to a
// 5–8 line call to this helper, vs the ~30–50 line per-method helpers
// the prototype required.
//
// Algebra contract for `view = fwd(a, p)`:
//   fwd     — forward computation. Pure function of (receiver, param).
//   solveA  — given a target view and a current param, return the
//             receiver that produces target. Used for residual flow.
//   solveP  — given a target view and a current receiver, return the
//             param that produces target. Used for view-write routing.
//   blendP  — (optional) linear blend on param space. Used for share()
//             with weight ≠ 1. Defaults to numeric lerp; supply your own
//             for non-numeric P (e.g., vec lerp).

/** @experimental — algebra spec consumed by `lensWithParam`. */
export interface LensAlgebra<V, P> {
  fwd: (a: V, p: P) => V;
  solveA: (target: V, p: P) => V;
  solveP: (target: V, a: V) => P;
  blendP?: (p: P, q: P, w: number) => P;
}

function defaultBlend<P>(p: P, q: P, w: number): P {
  // Numeric default — works for Num. For Vec/Pose/etc. supply your own.
  if (typeof p === "number" && typeof q === "number") {
    return (p + (q - p) * w) as unknown as P;
  }
  // Fallback: weight ≥ 0.5 picks target, else current. Not great, but
  // honest about the lack of a defined blend for arbitrary P.
  return w >= 0.5 ? q : p;
}

/** @experimental — the substrate-level lens builder. Dispatches to
 *  RO / share / own based on the param's brand. */
export function lensWithParam<V, P>(
  self: Writable<Signal<V>>,
  param: Param<P>,
  alg: LensAlgebra<V, P>,
): Writable<Signal<V>> {
  if (isOwn(param)) return _ownPath(self, param as Own<P>, alg);
  if (isShare(param)) return _sharePath(self, param as Share<P>, alg);
  return _roPath(self, param as Val<P>, alg);
}

function _roPath<V, P>(
  self: Writable<Signal<V>>,
  param: Val<P>,
  alg: LensAlgebra<V, P>,
): Writable<Signal<V>> {
  const pf = paramReader(param);
  // Use the instance `.lens(fwd, bwd)` form so the chain fuses with
  // receiver via `_fuse` — preserves `_fusedOf.parent` traversal that
  // diamond-detection (and downstream consumers like field fast-paths)
  // rely on. Bypassing `_fuse` with `Signal.install` directly would
  // break both.
  // biome-ignore lint/suspicious/noExplicitAny: cross-class instance method dispatch
  return (self as any).lens(
    (a: V) => alg.fwd(a, pf()),
    (v: V) => alg.solveA(v, pf()),
  ) as Writable<Signal<V>>;
}

function _sharePath<V, P>(
  self: Writable<Signal<V>>,
  shareArg: Share<P>,
  alg: LensAlgebra<V, P>,
): Writable<Signal<V>> {
  const sig = shareArg.sig as Writable<Signal<P>>;
  const wf = reader(shareArg.weight);
  const blend = alg.blendP ?? defaultBlend;
  const Cls = self.constructor as new (...args: never[]) => Signal<V>;
  return Signal.install(
    Cls,
    () => alg.fwd(self.value, sig.value),
    (target: V) => {
      batch(() => {
        const a = self.peek();
        const p = sig.peek();
        const w = wf();
        const p_full = alg.solveP(target, a);
        const p_desired = w === 1 ? p_full : blend(p, p_full, w);
        sig.value = p_desired;
        const p_actual = sig.peek();
        // Receiver absorbs whatever's left to reach `target` given the
        // sig value that actually landed (which may be clamped/quantized).
        self.value = alg.solveA(target, p_actual);
      });
    },
  ) as Writable<Signal<V>>;
}

function _ownPath<V, P>(
  self: Writable<Signal<V>>,
  ownArg: Own<P>,
  alg: LensAlgebra<V, P>,
): Writable<Signal<V>> {
  const sig = ownArg.sig as Writable<Signal<P>>;
  const bIntended = { value: alg.fwd(self.peek(), sig.peek()) };
  const Cls = self.constructor as new (...args: never[]) => Signal<V>;

  const setter = (target: V) => {
    withinOwner(token, () => {
      batch(() => {
        bIntended.value = target;
        const a = self.peek();
        const p_full = alg.solveP(target, a);
        sig.value = p_full;
        const p_actual = sig.peek();
        self.value = alg.solveA(target, p_actual);
      });
    });
  };

  const lens = Signal.install(
    Cls,
    () => alg.fwd(self.value, sig.value),
    setter,
  ) as Writable<Signal<V>>;
  (lens as { _ownName?: string })._ownName = `lensWithParam(own)`;
  const token = claim(ownArg, lens as object);

  network([self], dirty => {
    if (dirty.size === 0) return;
    withinOwner(token, () => {
      const a_now = self.peek();
      const p_full = alg.solveP(bIntended.value, a_now);
      sig.value = p_full;
      const p_actual = sig.peek();
      // Drift on saturation: if sig didn't take the full requested
      // change (clamp at boundary OR already-at-boundary stuck), accept
      // the new settled state. Without this, back-drags after a prior
      // saturation get "stuck" — bIntended stays at an unreachable
      // target and sig stays pinned at the boundary regardless of how
      // the receiver moves.
      //
      // Trade-off: this rule also drifts on quantize-style snaps where
      // actual ≠ desired but sig isn't truly saturated. For lenses
      // whose bwd snaps to discrete values (quantize), this means
      // bIntended tracks the snapped value rather than the requested
      // one — discrete "detents" get smoothed out into continuous
      // tracking. If you need detent behavior, use `share()` instead
      // of `own()` for that param.
      if (!sigEquals(sig, p_actual, p_full)) {
        bIntended.value = alg.fwd(a_now, p_actual);
      }
    });
  });

  return lens;
}

/** Use the signal's own `_equals` if present, else `===`. Used to
 *  detect whether sig took the full requested change. */
function sigEquals<P>(sig: Signal<P>, a: P, b: P): boolean {
  const eq = (sig as unknown as { _equals?: (a: P, b: P) => boolean })._equals;
  return eq ? eq(a, b) : a === b;
}
