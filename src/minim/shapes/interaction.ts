// DOM input → signal-world bridges that bind to scene-graph shapes.

import { type Cell, cell, type Inner, type Num, Vec, type Writable } from "@minim/signals";

type ClientPoint = { clientX: number; clientY: number };

import type { AnyShape } from "./shape";

// Shared page-pointer state for `cursor()`: one lazy window listener feeding
// one signal. `null` until the first `pointermove`. Never disposed.
let _clientPointer: Cell<ClientPoint | null> | null = null;
function pageClientPointer(): Cell<ClientPoint | null> {
  if (_clientPointer) return _clientPointer;
  const sig = cell<ClientPoint | null>(null);
  window.addEventListener("pointermove", (e: PointerEvent) => {
    sig.value = { clientX: e.clientX, clientY: e.clientY };
  });
  _clientPointer = sig;
  return sig;
}

const TAU = Math.PI * 2;
const wrapToPi = (x: number) => x - TAU * Math.round(x / TAU);

/** Set `sig` true/false from `mouseenter`/`mouseleave` on `shape`; returns a
 *  disposer. Lower-level than `hover(el, marker)` — writes the signal directly. */
export function hoverSignal(shape: AnyShape, sig: Writable<Cell<boolean>>): () => void {
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

/** Reactive `Vec` tracking the page pointer in `shape`'s SVG-root frame, via
 *  the shared window listener (N callers, one listener). `init` is returned
 *  before the first `pointermove` to avoid a first-frame jolt to (0, 0). */
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

/** Bind pointer drag on `shape` directly to a writable `Vec` (no handle dot);
 *  returns a disposer. `target` is in the SVG-root frame and coords are read
 *  via `toWorld`, so the grab offset survives bwd writes back through
 *  `shape.translate`. Grab offset is captured on pointerdown; optional
 *  `dragging` reports active state. Defaults `cursor` to `"grab"`. */
export function drag(
  shape: AnyShape,
  target: Writable<Vec>,
  dragging?: Writable<Cell<boolean>>,
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
 *  Cell<boolean>. Sugar for "give me a drag handle that exposes its
 *  own state." */
export function dragWithState(
  shape: AnyShape,
  target: Writable<Vec>,
): { dragging: Cell<boolean>; dispose: () => void } {
  const dragging = cell(false);
  const dispose = drag(shape, target, dragging);
  return { dragging, dispose };
}

/** Drag-to-rotate about the shape's local origin: writes `angle` so the
 *  grabbed point tracks the cursor (Δ = current − grab angle, shortest arc).
 *  Returns a disposer. */
export function dragRotate(
  shape: AnyShape,
  angle: Writable<Num>,
  dragging?: Writable<Cell<boolean>>,
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
