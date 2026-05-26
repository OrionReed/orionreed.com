// Pointer-drag helpers for rigid bodies.
//
// Plain `drag(shape, vec)` from `@minim/shapes` reads the cursor through
// `shape.toLocal()`, which composes the shape's local transform. That's
// wrong for rigid bodies whose render rect rotates with `body.angle` —
// the cursor would track a rotating frame. Both helpers here read the
// cursor through `shape.svgRoot.getScreenCTM()` instead, so world-space
// coords are stable regardless of the shape's rotation.
//
// Two flavours:
//   `dragBody`         — hard-pin via `world.addWhile(dragging, body.pin())`.
//                        Cell goes kinematic; body teleports to cursor.
//                        Use when you want the body to lead absolutely.
//   `dragBodyAnchored` — soft-pin via a `BodyAnchor` relation. The body
//                        keeps its mass and reacts to contacts, so a
//                        blocked body lags behind the cursor instead of
//                        punching through. Use when you want contacts
//                        to push back on the drag.

import type { AnyShape } from "@minim/shapes";
import { type Signal, signal, Vec, type Writable } from "@minim/signals";
import { type Body, BodyAnchor, bodyAnchor } from "./rigid";
import type { World } from "./world";

interface DragHandle {
  /** True while the user is mid-drag. Mirrors the `Handle.dragging`
   *  shape so callers can wire animator `rate` / cluster gating. */
  readonly dragging: Signal<boolean>;
  /** Tear down event listeners (and remove the soft anchor, if any).
   *  Idempotent. */
  dispose(): void;
}

interface PointerDragCore {
  shape: AnyShape;
  onStart(world: { x: number; y: number }): void;
  onMove(world: { x: number; y: number }): void;
  onStop(): void;
}

/** Shared pointer wiring: fires `onStart` on pointerdown with world
 *  coords, `onMove` each pointermove, `onStop` on pointerup/cancel.
 *  Reads cursor via `shape.toWorld(...)` so rotating shapes still give
 *  stable world coords. */
function bindPointerDrag(core: PointerDragCore): {
  dragging: Writable<Signal<boolean>>;
  dispose(): void;
} {
  const dragging = signal(false);
  let pointerId = -1;
  const offDown = core.shape.on("pointerdown", e => {
    const pe = e as PointerEvent;
    pointerId = pe.pointerId;
    core.shape.el.setPointerCapture(pointerId);
    core.onStart(core.shape.toWorld(pe));
    dragging.value = true;
  });
  const offMove = core.shape.on("pointermove", e => {
    if (pointerId === -1) return;
    core.onMove(core.shape.toWorld(e as PointerEvent));
  });
  const stop = (): void => {
    if (pointerId !== -1) {
      try {
        core.shape.el.releasePointerCapture(pointerId);
      } catch {
        /* fine */
      }
      pointerId = -1;
    }
    if (dragging.peek()) {
      core.onStop();
      dragging.value = false;
    }
  };
  const offUp = core.shape.on("pointerup", stop);
  const offCancel = core.shape.on("pointercancel", stop);
  return {
    dragging,
    dispose() {
      stop();
      offDown();
      offMove();
      offUp();
      offCancel();
    },
  };
}

/** Hard-pin drag for a rigid body. While the pointer is down, `body`
 *  becomes kinematic (mass → 0) via `body.pin()` and its `position` is
 *  written directly from the cursor in world coords. Release restores
 *  the body's diagonal mass `(m, m, I)`.
 *
 *  Use when the dragged body should lead absolutely (rope tips, chain
 *  links, gear knobs). For "body keeps its mass and reacts to contacts"
 *  drag, use `dragBodyAnchored` instead.
 *
 *  Sets `shape.el.style.cursor = "grab"` by default. */
export function dragBody(shape: AnyShape, world: World, body: Body): DragHandle {
  if (!shape.el.style.cursor) shape.el.style.cursor = "grab";

  let grabDx = 0;
  let grabDy = 0;
  const wired = bindPointerDrag({
    shape,
    onStart(w) {
      const p = body.position.value;
      grabDx = w.x - p.x;
      grabDy = w.y - p.y;
    },
    onMove(w) {
      body.position.value = { x: w.x - grabDx, y: w.y - grabDy };
    },
    onStop() {
      /* lifecycle below removes the pin */
    },
  });

  const lc = world.addWhile(wired.dragging, body.pin());

  return {
    dragging: wired.dragging,
    dispose() {
      lc.dispose();
      wired.dispose();
    },
  };
}

/** Soft-pin drag for a rigid body via `BodyAnchor`. The body keeps its
 *  finite mass and a finite-stiffness anchor pulls its translation
 *  toward the cursor. Blocked bodies lag behind the cursor rather than
 *  punching through neighbours.
 *
 *  `stiffness` is the anchor's pull strength (default `5e4`). Sets
 *  `shape.el.style.cursor = "grab"` by default. */
export function dragBodyAnchored(
  shape: AnyShape,
  world: World,
  body: Body,
  stiffness: number = 5e4,
): DragHandle {
  if (!shape.el.style.cursor) shape.el.style.cursor = "grab";

  let grabDx = 0;
  let grabDy = 0;
  let anchor: BodyAnchor | undefined;

  const wired = bindPointerDrag({
    shape,
    onStart(w) {
      const p = body.position.value;
      grabDx = w.x - p.x;
      grabDy = w.y - p.y;
      anchor = bodyAnchor(body, { x: p.x, y: p.y }, stiffness);
      world.add(anchor);
    },
    onMove(w) {
      if (!anchor) return;
      // Drive the anchor target — body translation chases it under load.
      (anchor.target as Writable<Vec>).value = { x: w.x - grabDx, y: w.y - grabDy };
    },
    onStop() {
      if (anchor) {
        world.remove(anchor);
        anchor = undefined;
      }
    },
  });

  return {
    dragging: wired.dragging,
    dispose() {
      wired.dispose();
      if (anchor) {
        world.remove(anchor);
        anchor = undefined;
      }
    },
  };
}
