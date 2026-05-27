// wp-pose.ts — writable-param lenses for Pose and Box.
//
// The interesting wp shapes here are those where the writable param
// represents a "decomposition handle" — a degree of freedom that's
// usually held constant but, when made writable, lets you steer the
// inverse.

import { Num, Pose, type Signal, Vec, type Writable } from "../../index";
import { lensTracked, type LensWOpts } from "./wp-detect";

type V = { x: number; y: number; theta: number };

// ─── Pose composition with writable offset ─────────────────────────

/** Compose a parent pose with a writable LOCAL pose. World pose = parent
 *  composed with local. Writes to world distribute:
 *    - Translation delta → local.x/y absorbs (parent unchanged).
 *    - Rotation delta → local.theta absorbs.
 *  This is the canonical "child pose follows parent, but drag the child
 *  to nudge its local offset" pattern (skeletal armatures, scene graphs). */
export function poseComposeW(
  parent: Writable<Pose>,
  local: Writable<Pose>,
  opts: LensWOpts = {},
): Writable<Pose> {
  return lensTracked(
    [parent, local] as const,
    ([pv, lv]) => {
      const cos = Math.cos(pv.theta);
      const sin = Math.sin(pv.theta);
      return {
        x: pv.x + cos * lv.x - sin * lv.y,
        y: pv.y + sin * lv.x + cos * lv.y,
        theta: pv.theta + lv.theta,
      };
    },
    (target, [pv, _lv]) => {
      // Decompose: local := target ⊖ parent.
      const dx = target.x - pv.x;
      const dy = target.y - pv.y;
      const cos = Math.cos(-pv.theta);
      const sin = Math.sin(-pv.theta);
      const newLocal: V = {
        x: cos * dx - sin * dy,
        y: sin * dx + cos * dy,
        theta: target.theta - pv.theta,
      };
      return [undefined, newLocal] as const;
    },
    Pose,
    opts,
  );
}

/** Pose with a separately-writable rotation knob. Dragging the result's
 *  POSITION absorbs into pos; setting `.value.theta` absorbs into rot.
 *  Both halves drag-able independently. */
export function poseFromParts(
  pos: Writable<Vec>,
  rot: Writable<Num>,
  opts: LensWOpts = {},
): Writable<Pose> {
  return lensTracked(
    [pos, rot] as const,
    ([pv, rv]) => ({ x: pv.x, y: pv.y, theta: rv }),
    (target, [_pv, _rv]) => [{ x: target.x, y: target.y }, target.theta] as const,
    Pose,
    opts,
  );
}

// ─── Vec from polar with writable radius/angle ─────────────────────

/** Polar reconstruction with both r and a writable. Drag the result →
 *  decompose into (r, angle) using the natural inverse. Center is held
 *  fixed (closed-form, like polar(c, r, a, "rotate")). */
export function polarW(
  center: Writable<Vec>,
  r: Writable<Num>,
  a: Writable<Num>,
  opts: LensWOpts = {},
): Writable<Vec> {
  return lensTracked(
    [center, r, a] as const,
    ([cv, rv, av]) => ({
      x: cv.x + rv * Math.cos(av),
      y: cv.y + rv * Math.sin(av),
    }),
    (target, [cv, _rv, _av]) => {
      const dx = target.x - cv.x;
      const dy = target.y - cv.y;
      return [undefined, Math.hypot(dx, dy), Math.atan2(dy, dx)] as const;
    },
    Vec,
    opts,
  );
}

// ─── Bounded scalar with writable bounds ────────────────────────────

/** Position-and-velocity pair: writable velocity that scales with a
 *  writable factor. Drag pos → both fields adjust together. */
export function physicsState(
  pos: Writable<Num>,
  vel: Writable<Num>,
  dt: Writable<Num>,
  opts: LensWOpts = {},
): Writable<Num> {
  return lensTracked(
    [pos, vel, dt] as const,
    ([pv, vv, dv]) => pv + vv * dv,
    (target, [pv, vv, dv]) => {
      // Asymmetric: writes back to vel only (pos and dt are "context").
      const delta = target - (pv + vv * dv);
      if (dv === 0) return [target, undefined, undefined] as const;
      return [undefined, vv + delta / dv, undefined] as const;
    },
    Num,
    opts,
  );
}
