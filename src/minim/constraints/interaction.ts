// Pointer-drag helpers for rigid bodies.
//
// These read the cursor in world space (via `shape.toWorld`) rather
// than the shape's local frame, which would track a rotating frame
// for bodies whose render rect rotates with `body.angle`.
//
// Two flavours:
//   `dragBody`         — hard-pin (kinematic, teleports to cursor);
//                        the body leads absolutely.
//   `dragBodyAnchored` — soft-pin via `BodyAnchor`; the body keeps
//                        its mass so contacts push back on the drag.

import type { AnyShape } from "@minim/shapes";
import { type Signal, signal, type Vec, type Writable } from "@minim/signals";
import { type Body, type BodyAnchor, bodyAnchor } from "./rigid";
import type { World } from "./world";

interface DragHandle {
  /** True while mid-drag; for wiring animator `rate` / cluster gating. */
  readonly dragging: Signal<boolean>;
  /** Tear down listeners (and the soft anchor, if any). Idempotent. */
  dispose(): void;
}

interface PointerDragCore {
  shape: AnyShape;
  onStart(world: { x: number; y: number }): void;
  onMove(world: { x: number; y: number }): void;
  onStop(): void;
}

/** Shared pointer wiring: `onStart`/`onMove`/`onStop` with cursor in
 *  world coords (via `shape.toWorld`, stable under rotation). */
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

/** Hard-pin drag: while down, `body` goes kinematic (`body.pin()`)
 *  and tracks the cursor exactly; release restores its mass. Use when
 *  the body should lead absolutely; for contact-reactive drag use
 *  `dragBodyAnchored`. Defaults `shape.el.style.cursor = "grab"`. */
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

/** Soft-pin drag via `BodyAnchor`: the body keeps its mass while a
 *  finite-`stiffness` anchor (default `5e4`) pulls it toward the
 *  cursor, so blocked bodies lag instead of punching through.
 *  Defaults `shape.el.style.cursor = "grab"`. */
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
