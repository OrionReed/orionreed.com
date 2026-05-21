// DOM input → signal-world bridges that bind to scene-graph shapes.

import {type Signal, signal, Vec, type Of, type Writable} from "@minim/signals";

type VecValue = Of<Vec>;
import type {AnyShape} from "./shape";

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
export function hoverSignal(shape: AnyShape, sig: Signal<boolean>): () => void {
  const off1 = shape.on("mouseenter", () => { sig.value = true; });
  const off2 = shape.on("mouseleave", () => { sig.value = false; });
  return () => { off1(); off2(); };
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
    handle.on("pointerdown", (e) => {
      const pe = e as PointerEvent;
      dragging = true;
      pointerId = pe.pointerId;
      handle.el.setPointerCapture(pointerId);
      onState?.(true);
      onDrag(handle.toLocal(pe));
    }),
  );
  offs.push(
    handle.on("pointermove", (e) => {
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
  return () => offs.forEach((d) => d());
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
  dragging?: Signal<boolean>,
): () => void {
  let dx = 0;
  let dy = 0;
  const offDown = shape.on("pointerdown", (e) => {
    const local = shape.toLocal(e as PointerEvent);
    const v = target.value;
    dx = local.x - v.x;
    dy = local.y - v.y;
  });
  const offDrag = draggable(
    shape,
    (local) => {
      target.value = { x: local.x - dx, y: local.y - dy };
    },
    dragging
      ? (active) => { dragging.value = active; }
      : undefined,
  );
  return () => { offDown(); offDrag(); };
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
