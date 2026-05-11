// Pointer / input helpers that bind to scene-graph shapes. Bridges the
// raw DOM event surface to minim's signal world via small wiring
// helpers — composable with `Awaitable`s, signals, and generators.

import type { Vec } from "../core/vec";
import type { AnyShape } from "./shape";

/** Wire `handle` for pointer-drag — every move while pressed calls
 *  `onDrag(local)` with the current pointer position in `handle`'s
 *  local coordinate frame. Captures the pointer so drags continue
 *  outside the handle's bounds. Returns a disposer. */
export function draggable(
  handle: AnyShape,
  onDrag: (local: Vec) => void,
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
