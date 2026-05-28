// DOM input → signal-world bridges that bind to scene-graph shapes.

import { type Inner, type Num, type Signal, signal, Vec, type Writable } from "@minim/signals";

type ClientPoint = { clientX: number; clientY: number };

import type { AnyShape } from "./shape";

// Shared page-pointer state for `cursor()` — one window listener,
// one signal, attached lazily on first call. The listener stays
// alive for the rest of the page's lifetime; nothing to dispose
// because nothing is per-instance. `null` until the first
// `pointermove` so consumers can show a sensible fallback.
let _clientPointer: Signal<ClientPoint | null> | null = null;
function pageClientPointer(): Signal<ClientPoint | null> {
  if (_clientPointer) return _clientPointer;
  const sig = signal<ClientPoint | null>(null);
  window.addEventListener("pointermove", (e: PointerEvent) => {
    sig.value = { clientX: e.clientX, clientY: e.clientY };
  });
  _clientPointer = sig;
  return sig;
}

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

/** Reactive `Vec` tracking the page pointer in `shape`'s SVG-root
 *  frame. Reads from a module-level signal fed by one shared
 *  `window` pointermove listener (attached lazily on first call),
 *  so updates fire wherever the cursor goes on the page — no
 *  capture rect needed — and N callers cost one listener, not N.
 *
 *  Cheap to subscribe: consumers (springs, effects, …) only re-run
 *  while their host Diagram's `Anim` is ticking, and the Diagram's
 *  visibility-gated rAF freezes the Anim when offscreen.
 *
 *  `init` is the value returned before the page has seen its first
 *  `pointermove`. Useful when a follower (spring, tween) reads on
 *  the first frame and you don't want a jolt to (0, 0). */
export function cursor(shape: AnyShape, init?: Inner<Vec>): Vec {
  const cp = pageClientPointer();
  const fallback: Inner<Vec> = init ?? { x: 0, y: 0 };
  return Vec.derive(cp, p => (p ? shape.toWorld(p) : fallback));
}

/** Wire `handle` for pointer-drag. Each pointermove while pressed
 *  calls `onDrag(local)` with the pointer in `handle`'s local frame;
 *  pointer-captured so drags survive leaving the handle. The optional
 *  `onState(active)` callback fires `true` on pointerdown and `false`
 *  on pointerup/cancel — `Handle` uses it to drive `.dragging`. */
export function draggable(
  handle: AnyShape,
  onDrag: (local: Inner<Vec>) => void,
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
 *  separate handle dot. `target` is interpreted in the SVG-root (world)
 *  frame. Pointer coords are read via `shape.toWorld(...)`, so the drag
 *  invariant holds even when `target`'s bwd chain writes back through
 *  `shape.translate` (or any ancestor transform) — `toLocal` would put
 *  the read frame in flux during the drag and break the grab offset.
 *
 *  Captures the grab offset on pointerdown so the pointer stays at the
 *  grab point. The optional `dragging` signal reports active/inactive
 *  (useful for `rate` on animators that should freeze during drag).
 *
 *  Sets `shape.el.style.cursor = "grab"` by default — callers that want
 *  a different cursor (e.g. `"ew-resize"`) assign after this call.
 *
 *  Returns a disposer. */
export function drag(
  shape: AnyShape,
  target: Writable<Vec>,
  dragging?: Writable<Signal<boolean>>,
): () => void {
  if (!shape.el.style.cursor) shape.el.style.cursor = "grab";
  let dx = 0;
  let dy = 0;
  let pointerId = -1;
  const offs: Array<() => void> = [];
  offs.push(
    shape.on("pointerdown", e => {
      const pe = e as PointerEvent;
      pointerId = pe.pointerId;
      shape.el.setPointerCapture(pointerId);
      const world = shape.toWorld(pe);
      const v = target.value;
      dx = world.x - v.x;
      dy = world.y - v.y;
      if (dragging) dragging.value = true;
    }),
  );
  offs.push(
    shape.on("pointermove", e => {
      if (pointerId === -1) return;
      const world = shape.toWorld(e as PointerEvent);
      target.value = { x: world.x - dx, y: world.y - dy };
    }),
  );
  const stop = () => {
    if (pointerId !== -1) {
      try {
        shape.el.releasePointerCapture(pointerId);
      } catch {
        /* ok */
      }
      pointerId = -1;
    }
    if (dragging) dragging.value = false;
  };
  offs.push(shape.on("pointerup", stop));
  offs.push(shape.on("pointercancel", stop));
  return () => offs.forEach(d => d());
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
  if (!shape.el.style.cursor) shape.el.style.cursor = "grab";
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
