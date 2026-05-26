// md-rigid-stack.ts — rigid-body playground.
//
// Three things share one `World`:
//
//   1. A 4-3-2-1 pyramid of boxes — full 3-DOF pose `(x, y, θ)`,
//      diagonal mass `(m, m, I)`, per-frame SAT broadphase,
//      `BoxContact` manifolds with normal + tangential rows
//      (Coulomb friction), and one taller free slab for variety.
//
//   2. A 3-segment IK arm anchored to the ceiling on the left.
//      Each segment is a rigid bar; consecutive bars hinge via
//      revolute `Joint`s. Drag the tip — the whole arm articulates
//      to follow your cursor (inverse kinematics for free, courtesy
//      of AVBD jointly solving everything).
//
//   3. A wrecking ball on a chain hanging from the right ceiling.
//      Five short bar links + a heavy box at the end. Drag the
//      ball, swing it into the stack, watch the pyramid scatter.
//
// Drag uses a soft `BodyAnchor` constraint (mass stays finite) so
// dragged bodies still react to contacts — you can lean the ball
// against a wall and feel resistance instead of mushing through.
//
// Reads cursor through the SVG root's CTM rather than `shape.toLocal`
// so a rotating rect's drag still returns stable world coords.

import { animate, type Body, body, dragBodyAnchored, joint, world } from "@minim/constraints";
import { Diagram, label, Mount, rect } from "../../minim";

const PALETTE = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321", "#9b59b6", "#1abc9c"];

export class MdRigidStack extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(760, 460);
    const cx = view.center.value.x;
    const floorY = view.bottom.up(40).value.y;
    const wallL = view.left.right(20).value.x;
    const wallR = view.right.left(20).value.x;
    const ceilingY = view.top.down(20).value.y;

    const w = world({
      gravity: [0, 1500],
      iterations: 24,
      postStabilize: true,
      // Mild damping rather than fully energy-conserving — small
      // perturbations bleed off rather than ringing through the stack.
      damping: 0.995,
    });

    // ─── Static walls, ground, and ceiling ──────────────────────
    w.add(
      body(
        { size: { w: wallR - wallL + 80, h: 16 }, density: 0, friction: 0.7 },
        { x: cx, y: floorY + 8 },
      ),
      body(
        { size: { w: 16, h: 400 }, density: 0, friction: 0.5 },
        { x: wallL - 8, y: floorY - 200 },
      ),
      body(
        { size: { w: 16, h: 400 }, density: 0, friction: 0.5 },
        { x: wallR + 8, y: floorY - 200 },
      ),
    );

    // ─── Pyramid stack in the centre ────────────────────────────
    const SIZE = 40;
    const PYRAMID_BASE = 4;
    const dynamicBoxes: Body[] = [];
    for (let row = 0; row < PYRAMID_BASE; row++) {
      const cols = PYRAMID_BASE - row;
      for (let col = 0; col < cols; col++) {
        const x = cx - ((cols - 1) * SIZE) / 2 + col * SIZE;
        const y = floorY - 8 - SIZE / 2 - row * (SIZE + 1);
        const b = w.add(
          body(
            { size: { w: SIZE - 2, h: SIZE - 2 }, density: 1, friction: 0.7 },
            { x, y, theta: 0 },
          ),
        );
        dynamicBoxes.push(b);
      }
    }
    // A slab plopped on top of the stack — heavy enough to compress
    // it slightly, light enough that the wrecking ball can knock it.
    const slab = w.add(
      body(
        { size: { w: 84, h: 16 }, density: 0.8, friction: 0.5 },
        { x: cx, y: floorY - 8 - SIZE * PYRAMID_BASE - 20 },
      ),
    );
    dynamicBoxes.push(slab);

    // ─── IK arm anchored to the left ceiling ────────────────────
    // Three rigid bars chained by revolute joints. The first joint
    // pins the shoulder to a static "anchor" body; subsequent joints
    // are end-to-end revolute hinges (free angle). Drag the tip and
    // the whole arm articulates to follow.
    const armX = wallL + 60;
    const armY = ceilingY + 30;
    const ARM_SEG_LEN = 80;
    const ARM_SEG_H = 12;
    const armAnchor = w.add(body({ size: { w: 10, h: 10 }, density: 0 }, { x: armX, y: armY }));
    const arm: Body[] = [];
    let prev: Body = armAnchor;
    for (let i = 0; i < 3; i++) {
      const seg = w.add(
        body(
          { size: { w: ARM_SEG_LEN - 1, h: ARM_SEG_H }, density: 1.2, friction: 0.5 },
          // theta=π/2 orients the segment's local +x downward, so the
          // body-local left end (-L/2, 0) maps to the world point
          // (body.x, body.y - L/2). Initial body.y = armY + (i+0.5)·L
          // makes that point land exactly on the previous anchor.
          { x: armX, y: armY + (i + 0.5) * ARM_SEG_LEN, theta: Math.PI / 2 },
        ),
      );
      arm.push(seg);
      w.add(
        joint(prev, seg, i === 0 ? { x: 0, y: 0 } : { x: ARM_SEG_LEN / 2, y: 0 }, {
          x: -ARM_SEG_LEN / 2,
          y: 0,
        }),
      );
      prev = seg;
    }

    // ─── Wrecking ball anchored to the right ceiling ────────────
    // Short chain links + heavy ball, rendered with the same rigid
    // bar + revolute joint pattern. Initial offset to one side so
    // the ball wants to swing — pendular by default.
    const ballX = wallR - 80;
    const ballY = ceilingY + 30;
    const CHAIN_SEG = 22;
    const CHAIN_W = 5;
    const CHAIN_N = 5;
    const ballAnchor = w.add(body({ size: { w: 10, h: 10 }, density: 0 }, { x: ballX, y: ballY }));
    const chain: Body[] = [];
    let prev2: Body = ballAnchor;
    // Initial pendulum offset: hang slightly to the right so it has
    // some swing energy when the scene starts.
    const tilt = 0.15;
    for (let i = 0; i < CHAIN_N; i++) {
      const link = w.add(
        body(
          { size: { w: CHAIN_SEG, h: CHAIN_W }, density: 0.6, friction: 0.3 },
          {
            x: ballX + Math.sin(tilt) * (i + 0.5) * CHAIN_SEG,
            y: ballY + Math.cos(tilt) * (i + 0.5) * CHAIN_SEG,
            theta: Math.PI / 2 + tilt,
          },
        ),
      );
      chain.push(link);
      w.add(
        joint(prev2, link, i === 0 ? { x: 0, y: 0 } : { x: CHAIN_SEG / 2, y: 0 }, {
          x: -CHAIN_SEG / 2,
          y: 0,
        }),
      );
      prev2 = link;
    }
    const ball = w.add(
      body(
        { size: { w: 40, h: 40 }, density: 4, friction: 0.6 },
        {
          x: ballX + Math.sin(tilt) * (CHAIN_N * CHAIN_SEG + 22),
          y: ballY + Math.cos(tilt) * (CHAIN_N * CHAIN_SEG + 22),
          theta: 0,
        },
      ),
    );
    w.add(joint(chain[chain.length - 1]!, ball, { x: CHAIN_SEG / 2, y: 0 }, { x: 0, y: -22 }));

    // ─── Render statics ─────────────────────────────────────────
    s(
      rect(wallL - 16, floorY, wallR - wallL + 32, 16, {
        fill: "rgba(120, 120, 120, 0.5)",
        thin: true,
      }),
    );
    s(rect(wallL - 16, floorY - 400, 16, 400, { fill: "rgba(120, 120, 120, 0.3)", thin: true }));
    s(rect(wallR, floorY - 400, 16, 400, { fill: "rgba(120, 120, 120, 0.3)", thin: true }));
    // Anchor markers.
    s(rect(armX - 6, armY - 6, 12, 12, { fill: "rgba(120, 120, 120, 0.6)", thin: true }));
    s(rect(ballX - 6, ballY - 6, 12, 12, { fill: "rgba(120, 120, 120, 0.6)", thin: true }));

    // ─── Render dynamics ────────────────────────────────────────
    const renderBody = (b: Body, fill: string) => {
      const r = s(rect(b.position, b.w, b.h, { fill, corner: 2, thin: true, rotate: b.angle }));
      dragBodyAnchored(r, w, b);
      return r;
    };

    for (let i = 0; i < dynamicBoxes.length; i++) {
      const color = PALETTE[i % PALETTE.length]!;
      renderBody(dynamicBoxes[i]!, color);
    }
    for (const seg of arm) renderBody(seg, "#7a8ba6");
    for (const link of chain) renderBody(link, "#665");
    renderBody(ball, "#3a3a3a");

    this.anim.start(animate(w));

    s(
      label(
        view.top.down(14),
        "drag any body — pyramid stacks, IK arm articulates, wrecking ball swings",
      ),
      label(
        view.bottom.up(16),
        `${dynamicBoxes.length} stack · ${arm.length}-bar IK arm · ${chain.length}-link chain + ball · diag(m, m, I) cells · SAT + Coulomb`,
        { size: 10 },
      ),
    );
  }
}
