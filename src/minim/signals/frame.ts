// Frame: a coordinate system, expressed as a `Reactive<Matrix2D>`.
//
// There's almost nothing here because the framework already gives us
// what we need:
//
//   - `Matrix2D.multiply(other)` is the composition operation; calling
//     it on a reactive matrix yields a reactive composed matrix.
//   - `pt.in(matrix)` and `box.in(matrix)` are the cross-frame
//     operations, registered as ops on Vec/Box.
//
// So a "Frame" is just a Reactive<Matrix2D>, and `parent.child(local)`
// is just `parent.multiply(local)`. The module exists to give those
// operations a name that reads naturally in scene-graph code:
//
//   const root  = Frame.identity();
//   const local = Matrix2D.signal(...);
//   const child = Frame.child(root, local);   // Reactive<M>
//
//   const ptInWorld   = pt.in(child);          // Reactive<V>
//   const boxInWorld  = box.in(child);         // Reactive<Box>
//
// Replaces: Shape.transform composition, aabbInRoot, aabbIn, the
// cross-frame logic in Shape.boundary and Shape.toLocal. All of those
// reduce to `value.in(targetFrame)`.

import { Matrix2D, type M } from "./matrix";
import { Signal } from "../core/signal";

const IDENTITY: M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A Frame is just a Reactive<Matrix2D> — writable or derived. The
 *  union models "the result of `Matrix2D.signal()` or `.derived()` or
 *  `.lens()` or any composition thereof." */
export type Frame =
  | ReturnType<typeof Matrix2D.signal>
  | ReturnType<typeof Matrix2D.derived>;

export const Frame = {
  /** Plain identity matrix value (not reactive). Useful as a fallback. */
  IDENTITY,

  /** A fresh writable identity-frame. */
  identity: () => Matrix2D.signal({ ...IDENTITY }),

  /** Child frame: `parent · local`. The result is a derived
   *  Reactive<M> that updates when either input changes. */
  child: (parent: Frame, local: Frame | M): Frame => {
    const localR =
      local instanceof Signal ? (local as Frame) : Matrix2D.signal(local as M);
    return parent.multiply(localR);
  },
};
