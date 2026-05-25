// DOM input → signal-world bridges that bind to scene-graph shapes.

import { Num, type Of, type Signal, signal, Vec, type Writable } from "@minim/signals";

type VecValue = Of<Vec>;

import type { AnyShape } from "./shape";

const TAU = Math.PI * 2;
const wrapToPi = (x: number) => x - TAU * Math.round(x / TAU);

/** Wire `mouseenter`/`mouseleave` on a shape to a writable boolean signal.
 *  Lower-level than `hover(el, marker)` in `core/marker` — directly sets the
 *  signal rather than creating a bound local. Useful when you want to write a
 *  specific signal on hover (e.g., to coordinate two shapes without a Marker),
 *  or when you already have a local signal from `marker.bind()`.
 *
 *      // Wire the shape's hover into a Marker's local:
 *      const local = signal(false);
 *      this.root.track(marker.bind(local));
 *      this.root.track(hoverSignal(ball, local));
 *
 *      // Or just use hover(el, marker) from core/marker for the common case.
 *
 *  Returns a disposer that removes the listeners. */
export function hoverSignal(shape: AnyShape, sig: Writable<Signal<boolean>>): () => void {
  const off1 = shape.on("mouseenter", () => {
    sig.value = true;
  });
  const off2 = shape.on("mouseleave", () => {
    sig.value = false;
  });
  return () => {
    off1();
    off2();
  };
}

/** Wire `handle` for pointer-drag. Each pointermove while pressed
 *  calls `onDrag(local)` with the pointer in `handle`'s local frame;
 *  pointer-captured so drags survive leaving the handle. The optional
 *  `onState(active)` callback fires `true` on pointerdown and `false`
 *  on pointerup/cancel — `Handle` uses it to drive `.dragging`. */
export function draggable(
  handle: AnyShape,
  onDrag: (local: VecValue) => void,
  onState?: (active: boolean) => void,
): () => void {
  let dragging = false;
  let pointerId = -1;
  const offs: Array<() => void> = [];
  offs.push(
    handle.on("pointerdown", e => {
      const pe = e as PointerEvent;
      dragging = true;
      pointerId = pe.pointerId;
      handle.el.setPointerCapture(pointerId);
      onState?.(true);
      onDrag(handle.toLocal(pe));
    }),
  );
  offs.push(
    handle.on("pointermove", e => {
      if (!dragging) return;
      onDrag(handle.toLocal(e as PointerEvent));
    }),
  );
  const stop = () => {
    if (dragging && pointerId !== -1) {
      try {
        handle.el.releasePointerCapture(pointerId);
      } catch {
        /* ok */
      }
    }
    dragging = false;
    pointerId = -1;
    onState?.(false);
  };
  offs.push(handle.on("pointerup", stop));
  offs.push(handle.on("pointercancel", stop));
  return () => offs.forEach(d => d());
}

/** Bind pointer drag on `shape` directly to a writable `Vec` — no
 *  separate handle dot. Captures the grab offset on pointerdown so the
 *  pointer stays at the grab point during the drag. The optional
 *  `dragging` signal reports active/inactive (useful for `rate` on
 *  animators that should freeze during drag).
 *
 *  Returns a disposer. */
export function drag(
  shape: AnyShape,
  target: Writable<Vec>,
  dragging?: Writable<Signal<boolean>>,
): () => void {
  let dx = 0;
  let dy = 0;
  const offDown = shape.on("pointerdown", e => {
    const local = shape.toLocal(e as PointerEvent);
    const v = target.value;
    dx = local.x - v.x;
    dy = local.y - v.y;
  });
  const offDrag = draggable(
    shape,
    local => {
      target.value = { x: local.x - dx, y: local.y - dy };
    },
    dragging
      ? active => {
          dragging.value = active;
        }
      : undefined,
  );
  return () => {
    offDown();
    offDrag();
  };
}

/** Wrap a `drag(shape, target)` call and return a local `dragging`
 *  Signal<boolean>. Sugar for "give me a drag handle that exposes its
 *  own state." */
export function dragWithState(
  shape: AnyShape,
  target: Writable<Vec>,
): { dragging: Signal<boolean>; dispose: () => void } {
  const dragging = signal(false);
  const dispose = drag(shape, target, dragging);
  return { dragging, dispose };
}

/** Drag-to-rotate: drag anywhere on `shape` and the writable `angle`
 *  updates so the clicked point follows the cursor. The shape rotates
 *  about its local origin (`transform.origin`, default `(0, 0)`).
 *
 *  How it works: `shape.toLocal(pointer)` gives the pointer in the
 *  shape's intrinsic frame — the shape's rotation pivot is at `(0, 0)`
 *  there. The angle of that vector to `(0, 0)` is the "intrinsic grab
 *  angle." As the user drags, the same intrinsic point should stay
 *  under the cursor — so the angle write equals (current intrinsic
 *  cursor angle) − (grab intrinsic angle), wrapped to shortest arc.
 *
 *  Returns a disposer. */
export function dragRotate(
  shape: AnyShape,
  angle: Writable<Num>,
  dragging?: Writable<Signal<boolean>>,
): () => void {
  let grabAngle = 0;
  const offDown = shape.on("pointerdown", e => {
    const local = shape.toLocal(e as PointerEvent);
    grabAngle = Math.atan2(local.y, local.x);
  });
  const stop = draggable(
    shape,
    local => {
      const currentAngle = Math.atan2(local.y, local.x);
      const current = angle.peek();
      angle.value = current + wrapToPi(currentAngle - grabAngle);
    },
    dragging
      ? active => {
          dragging.value = active;
        }
      : undefined,
  );
  return () => {
    offDown();
    stop();
  };
}
