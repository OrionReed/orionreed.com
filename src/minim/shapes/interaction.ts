// DOM input → signal-world bridges that bind to scene-graph shapes.

import {type Signal, type VecValue} from "@minim/signals";
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
 *  pointer-captured so drags survive leaving the handle. */
export function draggable(
  handle: AnyShape,
  onDrag: (local: VecValue) => void,
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
  };
  offs.push(handle.on("pointerup", stop));
  offs.push(handle.on("pointercancel", stop));
  return () => offs.forEach((d) => d());
}
