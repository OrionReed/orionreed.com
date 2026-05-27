// wp-auto.ts — exploration of auto-detection API.
//
// Question: can we have a SINGLE method `.rightAuto(n)` that:
//   - if n is a literal number → acts read-only (today's behavior)
//   - if n is a Read<Num> (computed, derive) → acts read-only
//   - if n is a Writable<Num> → acts writable-param (the new behavior)
//
// With the result type ALWAYS Writable<Vec> (writability inherited from
// the receiver, independent of the param), as our invariant requires.
//
// Type-level dispatch uses conditional types: if n extends WritableBrand,
// promote; else, classical.

import {
  isSignal,
  Num,
  type Read,
  Signal,
  type Val,
  Vec,
  type Writable,
  type WritableBrand,
} from "../../index";

type V = { x: number; y: number };

/** A parameter that *may* be writable. The runtime probe decides. */
type MaybeWritable<T> = Val<T> | (Read<T> & WritableBrand);

function isWritableSig(v: unknown): v is Signal<unknown> & WritableBrand {
  return isSignal(v) && (v as Signal<unknown>).setter !== undefined;
}

function isReactivePrimitive(v: unknown): v is Signal<unknown> {
  // True if v is a Signal in signal-mode (root primitive, has no getter).
  return isSignal(v) && (v as Signal<unknown>).getter === undefined;
}

function isWritableParticipant(v: unknown): v is Signal<unknown> {
  return isWritableSig(v) || isReactivePrimitive(v);
}

/** Polymorphic vec.right:
 *   - n a literal or RO signal → behaves like `a.right(n)`, all writes to a.
 *   - n a writable signal → behaves like `vecRightW(a, n)`, n absorbs the
 *                            x-component delta.
 *  Return type: always `Writable<Vec>`. */
export function rightAuto<N extends MaybeWritable<number>>(
  a: Writable<Vec>,
  n: N,
): Writable<Vec> {
  if (isWritableParticipant(n)) {
    const nSig = n as Writable<Num>;
    return Vec.lens(
      [a, nSig] as const,
      ([av, nv]) => ({ x: av.x + nv, y: av.y }),
      (target, [av, _nv]) => [{ x: av.x, y: target.y }, target.x - av.x] as const,
    );
  }
  // RO/literal path: identical to existing `a.right(n)` semantics.
  if (isSignal(n)) {
    return a.lens(
      v => ({ x: v.x + (n as Read<number>).value, y: v.y }),
      o => ({ x: o.x - (n as Read<number>).value, y: o.y }),
    );
  }
  const k = n as number;
  return a.lens(
    v => ({ x: v.x + k, y: v.y }),
    o => ({ x: o.x - k, y: o.y }),
  );
}
