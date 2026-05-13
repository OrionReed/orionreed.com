// DOM input → signal-world bridges that bind to scene-graph shapes.

import { type Signal } from "../core/signal";
import type { V } from "../signals/vec";
import type { AnyShape } from "./shape";

/** Wire `mouseenter`/`mouseleave` on a shape to a writable boolean
 *  signal. Typical use: link a shape's hover state to a `Marker`:
 *
 *      const m = new Marker().register("sim:mass");
 *      scene.track(hoverSignal(ball, m.highlighted));
 *      effect(() => ball.attr("fill", m.highlighted.value ? AMBER : DEFAULT));
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
  onDrag: (local: V) => void,
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
