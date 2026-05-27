// md-skeletal-rig.ts — Tree<Pose> with hierarchical world-pose composition.
//
// A 2D stick figure built as a tree of bones. Each node carries a
// LOCAL pose (offset + rotation relative to its parent's frame); the
// WORLD pose at each node is `compose(parent.world, this.local)` —
// one derived chain per node, running through the engine's existing
// Pose machinery. Bones render as line segments from each non-root
// node's world position back to its parent's.
//
// The interaction: drag any joint. The drag handle is a `Vec.lens`
// over `[parent.world, this.local]` — read returns the joint's world
// position (the compose); write `decompose`'s the new world position
// back into `this.local`, preserving the joint's current orientation
// and the parent's world pose. Descendants follow via the same
// composition chain; ancestors stay put because nothing wrote to
// them. The TREE STRUCTURE is what makes this work — dragging the
// left hand bends the left arm only; the right arm and legs are
// structurally independent branches.
//
// No IK solver, no per-joint constraints, no special-cased cascade
// logic — just `compose` / `decompose` per node, threaded through the
// engine's normal lens machinery.
//
//   torso ─┬ head
//          ├ left shoulder ─ left elbow ─ left hand
//          ├ right shoulder ─ right elbow ─ right hand
//          ├ left hip ─ left knee ─ left foot
//          └ right hip ─ right knee ─ right foot

import {
  circle,
  Diagram,
  drag,
  type Inner,
  label,
  line,
  type Mount,
  Pose,
  pose,
  type TreeNode,
  treeNode,
  Vec,
  walkTree,
  type Writable,
} from "../../minim";

type PoseV = Inner<Pose>;
type VecV = Inner<Vec>;

// ─── Pose composition (parent frame ∘ local frame → world frame) ──

/** Compose a parent's world pose with a local pose to get the
 *  child's world pose. Standard 2-D rigid-body composition: rotate
 *  the local frame's origin by the parent's angle, translate to the
 *  parent's position, sum the angles. */
function compose(parent: PoseV, local: PoseV): PoseV {
  const c = Math.cos(parent.theta);
  const s = Math.sin(parent.theta);
  return {
    x: parent.x + c * local.x - s * local.y,
    y: parent.y + s * local.x + c * local.y,
    theta: parent.theta + local.theta,
  };
}

/** Inverse of `compose`: given the desired world pose and the
 *  parent's world pose, return the local pose that composes to it.
 *  `decompose(compose(p, l), p) = l` (exact under floating point
 *  modulo trig roundoff). */
function decompose(world: PoseV, parent: PoseV): PoseV {
  const dx = world.x - parent.x;
  const dy = world.y - parent.y;
  const c = Math.cos(-parent.theta);
  const s = Math.sin(-parent.theta);
  return {
    x: c * dx - s * dy,
    y: s * dx + c * dy,
    theta: world.theta - parent.theta,
  };
}

// ─── Bone shape ──────────────────────────────────────────────────

interface Bone {
  name: string;
  /** Pose relative to the parent's frame. Writable; drives the rig. */
  local: Writable<Pose>;
  /** Pose in world coords — derived from parent.world + local. */
  world: Pose;
  /** A `Writable<Vec>` over the joint's world XY position. Reads the
   *  current world position; writes it back by updating `local`. */
  posHandle: Writable<Vec>;
  /** A `Writable<Vec>` over a "rotation thumb" position — a point at
   *  fixed radius from the joint, on the joint's world-theta ray.
   *  Reads compose joint pos + R·(cos θ, sin θ); writes turn the
   *  target back into a new local theta via atan2. */
  rotThumb: Writable<Vec>;
}

const ROT_RADIUS = 22;

/** Build a bone with its local cell, world derivation, drag handle,
 *  and rotation thumb. `parent` is `null` for the root (where world
 *  = local). */
function bone(name: string, localPose: PoseV, parent: Bone | null): Bone {
  const local = pose(localPose);
  let world: Pose;
  let posHandle: Writable<Vec>;
  let rotThumb: Writable<Vec>;

  if (parent === null) {
    // Root: world IS local.
    world = Pose.derive(local, l => l) as Pose;
    posHandle = Vec.lens(
      local,
      l => ({ x: l.x, y: l.y }),
      (target, current) => ({ ...current, x: target.x, y: target.y }),
    );
    rotThumb = Vec.lens(
      local,
      l => ({
        x: l.x + ROT_RADIUS * Math.cos(l.theta),
        y: l.y + ROT_RADIUS * Math.sin(l.theta),
      }),
      (target, current) => {
        const angle = Math.atan2(target.y - current.y, target.x - current.x);
        return { ...current, theta: angle };
      },
    );
  } else {
    // Non-root: world is the compose chain.
    world = Pose.derive(
      [parent.world, local] as const,
      ([pw, l]: readonly [PoseV, PoseV]) => compose(pw, l),
    );
    posHandle = Vec.lens(
      [parent.world, local] as const,
      (vals: readonly [PoseV, PoseV]) => {
        const [pw, l] = vals;
        const w = compose(pw, l);
        return { x: w.x, y: w.y };
      },
      (target, vals) => {
        const [pw, l] = vals as readonly [PoseV, PoseV];
        const currentWorld = compose(pw, l);
        // Preserve current world theta (drag translates only).
        const newWorld: PoseV = { x: target.x, y: target.y, theta: currentWorld.theta };
        const newLocal = decompose(newWorld, pw);
        return [undefined, newLocal] as never;
      },
    );
    rotThumb = Vec.lens(
      [parent.world, local] as const,
      (vals: readonly [PoseV, PoseV]) => {
        const [pw, l] = vals;
        const w = compose(pw, l);
        return {
          x: w.x + ROT_RADIUS * Math.cos(w.theta),
          y: w.y + ROT_RADIUS * Math.sin(w.theta),
        };
      },
      (target, vals) => {
        const [pw, l] = vals as readonly [PoseV, PoseV];
        const w = compose(pw, l);
        const newWorldTheta = Math.atan2(target.y - w.y, target.x - w.x);
        const newLocalTheta = newWorldTheta - pw.theta;
        return [undefined, { x: l.x, y: l.y, theta: newLocalTheta }] as never;
      },
    );
  }

  return { name, local, world, posHandle, rotThumb };
}

// ─── The rig ─────────────────────────────────────────────────────

const W = 640;
const H = 420;
const FX = W / 2;
const FY = H / 2 - 30;

// Default local poses. Limbs have a slight non-zero local theta so
// they don't all stack on a vertical line — the figure stands with
// arms slightly out, legs slightly apart.

const LOCAL = {
  TORSO: { x: FX, y: FY, theta: 0 },
  HEAD: { x: 0, y: -55, theta: 0 },
  LSHOULDER: { x: -32, y: -30, theta: 0.3 },
  LELBOW: { x: 0, y: 44, theta: -0.2 },
  LHAND: { x: 0, y: 42, theta: 0 },
  RSHOULDER: { x: 32, y: -30, theta: -0.3 },
  RELBOW: { x: 0, y: 44, theta: 0.2 },
  RHAND: { x: 0, y: 42, theta: 0 },
  LHIP: { x: -14, y: 30, theta: 0.15 },
  LKNEE: { x: 0, y: 46, theta: -0.1 },
  LFOOT: { x: 0, y: 44, theta: 0 },
  RHIP: { x: 14, y: 30, theta: -0.15 },
  RKNEE: { x: 0, y: 46, theta: 0.1 },
  RFOOT: { x: 0, y: 44, theta: 0 },
};

interface RigNode extends TreeNode<Bone> {
  readonly value: Bone;
  readonly children: readonly RigNode[];
}

/** Build the rig top-down so each bone's parent is constructed first. */
function buildRig(): RigNode {
  const torso = bone("torso", LOCAL.TORSO, null);
  const head = bone("head", LOCAL.HEAD, torso);

  const lShoulder = bone("L shoulder", LOCAL.LSHOULDER, torso);
  const lElbow = bone("L elbow", LOCAL.LELBOW, lShoulder);
  const lHand = bone("L hand", LOCAL.LHAND, lElbow);

  const rShoulder = bone("R shoulder", LOCAL.RSHOULDER, torso);
  const rElbow = bone("R elbow", LOCAL.RELBOW, rShoulder);
  const rHand = bone("R hand", LOCAL.RHAND, rElbow);

  const lHip = bone("L hip", LOCAL.LHIP, torso);
  const lKnee = bone("L knee", LOCAL.LKNEE, lHip);
  const lFoot = bone("L foot", LOCAL.LFOOT, lKnee);

  const rHip = bone("R hip", LOCAL.RHIP, torso);
  const rKnee = bone("R knee", LOCAL.RKNEE, rHip);
  const rFoot = bone("R foot", LOCAL.RFOOT, rKnee);

  const leaf = (b: Bone): RigNode => treeNode(b) as RigNode;
  const branch = (b: Bone, children: RigNode[]): RigNode =>
    treeNode(b, children) as RigNode;

  return branch(torso, [
    leaf(head),
    branch(lShoulder, [branch(lElbow, [leaf(lHand)])]),
    branch(rShoulder, [branch(rElbow, [leaf(rHand)])]),
    branch(lHip, [branch(lKnee, [leaf(lFoot)])]),
    branch(rHip, [branch(rKnee, [leaf(rFoot)])]),
  ]);
}

// ─── Rendering ───────────────────────────────────────────────────

const TORSO_FILL = "#5b8def";
const SHOULDER_FILL = "#7ed321";
const EXTREMITY_FILL = "#222";
const BONE_STROKE = "#222";
const ROT_STROKE = "#5b8def";
const ROT_FILL = "#5b8def";

function isTorso(name: string): boolean {
  return name === "torso";
}
function isHubJoint(name: string): boolean {
  return (
    name === "L shoulder" ||
    name === "R shoulder" ||
    name === "L hip" ||
    name === "R hip" ||
    name === "head"
  );
}
/** A "leaf" joint is one whose theta has no descendants to affect.
 *  Hands, feet, and the head — these still HAVE a local theta cell
 *  but rotating it has no visible effect, so we skip the gizmo. */
function isLeafJoint(name: string): boolean {
  return (
    name === "L hand" ||
    name === "R hand" ||
    name === "L foot" ||
    name === "R foot" ||
    name === "head"
  );
}

export class MdSkeletalRig extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const rig = buildRig();

    s(
      label(
        view.top.down(20),
        "drag joints to translate; drag the small gizmo dot to rotate — limbs bend independently per branch",
      ),
    );

    // Draw bones (line from parent's world position to this bone's).
    // We need parent references for that; walk and track.
    const drawBones = (n: RigNode, parent: RigNode | null): void => {
      if (parent !== null) {
        const parentPos = Vec.derive(parent.value.world, p => ({ x: p.x, y: p.y }));
        const childPos = Vec.derive(n.value.world, p => ({ x: p.x, y: p.y }));
        s(line(parentPos, childPos, { stroke: BONE_STROKE, strokeWidth: 3, cap: "round" }));
      }
      for (const c of n.children) drawBones(c as RigNode, n);
    };
    drawBones(rig, null);

    // Rotation gizmos first (so they render behind the joint circles).
    walkTree(rig, n => {
      const b = (n as RigNode).value;
      if (isLeafJoint(b.name)) return; // hands / feet / head don't rotate visibly
      const jointPos = Vec.derive(b.world, p => ({ x: p.x, y: p.y }));
      const thumbPos = Vec.derive(b.rotThumb, t => ({ x: t.x, y: t.y }));
      // Line from joint to thumb showing the bone's frame direction.
      s(line(jointPos, thumbPos, { thin: true, stroke: ROT_STROKE, opacity: 0.6 }));
      // The thumb itself is draggable; drag → rotates the bone's local theta.
      const thumb = s(circle(thumbPos, 4, { fill: ROT_FILL, stroke: "#222", thin: true }));
      drag(thumb, b.rotThumb);
      thumb.el.style.cursor = "grab";
    });

    // Joint circles — drag the visible circle directly (no separate halo).
    walkTree(rig, n => {
      const b = (n as RigNode).value;
      const worldPos = Vec.derive(b.world, p => ({ x: p.x, y: p.y }));
      const isRoot = isTorso(b.name);
      const isHub = isHubJoint(b.name);
      const r = isRoot ? 10 : isHub ? 7 : 5;
      const fill = isRoot ? TORSO_FILL : isHub ? SHOULDER_FILL : EXTREMITY_FILL;
      const c = s(circle(worldPos, r, { fill, stroke: "#000", thin: true }));
      drag(c, b.posHandle);
      c.el.style.cursor = "grab";
    });

    s(
      label(
        view.bottom.up(14),
        "world = compose(parent.world, local); drag inverts via decompose — 13 cells, 12 derivations, 0 IK",
        { size: 10 },
      ),
    );
  }
}
