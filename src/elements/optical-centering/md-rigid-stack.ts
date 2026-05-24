// md-rigid-stack.ts — rigid-body playground.
//
// Three things share one `RigidWorld`:
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

import {
  type Body,
  body,
  type BodyAnchor,
  bodyAnchor,
  joint,
  RigidWorld,
} from "@minim/constraints";
import {
  Anchor,
  type AnyShape,
  Diagram,
  label,
  Mount,
  rect,
  type Signal,
  signal,
  type Writable,
} from "../../minim";

function findSvgRoot(el: Element | null): SVGSVGElement | null {
  let walker: Element | null = el;
  while (walker) {
    if (walker.tagName === "svg") return walker as SVGSVGElement;
    walker = walker.parentElement;
  }
  return null;
}

/** Drag a rigid `body` via a soft `BodyAnchor` constraint that pulls
 *  the body's translation toward the cursor. Mass stays finite so
 *  contacts can push back — no more "mush" through neighbours when
 *  you drag a stack. Reads cursor in the SVG root's frame so it
 *  works correctly even when the body's render rect is rotated. */
function dragBody(
  shape: AnyShape,
  world: RigidWorld,
  body: Body,
  dragging: Signal<boolean>,
  stiffness = 5e4,
): () => void {
  const root = findSvgRoot(shape.el);
  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const ctm = root?.getScreenCTM()?.inverse();
    if (!ctm) return { x: 0, y: 0 };
    return {
      x: clientX * ctm.a + clientY * ctm.c + ctm.e,
      y: clientX * ctm.b + clientY * ctm.d + ctm.f,
    };
  };
  let pointerId = -1;
  let dx = 0;
  let dy = 0;
  let anchor: BodyAnchor | undefined;
  const offDown = shape.on("pointerdown", e => {
    const pe = e as PointerEvent;
    const w = toWorld(pe.clientX, pe.clientY);
    const p = body.pose.value;
    dx = w.x - p.x;
    dy = w.y - p.y;
    pointerId = pe.pointerId;
    shape.el.setPointerCapture(pointerId);
    (dragging as Writable<typeof dragging>).value = true;
    anchor = bodyAnchor(body, { x: p.x, y: p.y }, stiffness);
    world.add(anchor);
  });
  const offMove = shape.on("pointermove", e => {
    if (pointerId === -1 || !anchor) return;
    const pe = e as PointerEvent;
    const w = toWorld(pe.clientX, pe.clientY);
    anchor.target.value = { x: w.x - dx, y: w.y - dy };
  });
  const stop = () => {
    if (pointerId !== -1) {
      try {
        shape.el.releasePointerCapture(pointerId);
      } catch {
        /* fine */
      }
      pointerId = -1;
    }
    if (anchor) {
      world.remove(anchor);
      anchor = undefined;
    }
    (dragging as Writable<typeof dragging>).value = false;
  };
  const offUp = shape.on("pointerup", stop);
  const offCancel = shape.on("pointercancel", stop);
  return () => {
    offDown();
    offMove();
    offUp();
    offCancel();
  };
}

const PALETTE = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321", "#9b59b6", "#1abc9c"];

export class MdRigidStack extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(760, 460);
    const cx = view.center.value.x;
    const floorY = view.bottom.up(40).value.y;
    const wallL = view.left.right(20).value.x;
    const wallR = view.right.left(20).value.x;
    const ceilingY = view.top.down(20).value.y;

    const world = new RigidWorld({
      gravity: [0, 1500],
      iterations: 24,
      postStabilize: true,
      // Mild damping rather than fully energy-conserving — small
      // perturbations bleed off rather than ringing through the stack.
      damping: 0.995,
    });

    // ─── Static walls, ground, and ceiling ──────────────────────
    world.add(
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
        const b = world.add(
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
    const slab = world.add(
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
    const armAnchor = world.add(
      body({ size: { w: 10, h: 10 }, density: 0 }, { x: armX, y: armY }),
    );
    const arm: Body[] = [];
    let prev: Body = armAnchor;
    for (let i = 0; i < 3; i++) {
      const seg = world.add(
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
      world.add(
        joint(
          prev,
          seg,
          i === 0 ? { x: 0, y: 0 } : { x: ARM_SEG_LEN / 2, y: 0 },
          { x: -ARM_SEG_LEN / 2, y: 0 },
        ),
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
    const ballAnchor = world.add(
      body({ size: { w: 10, h: 10 }, density: 0 }, { x: ballX, y: ballY }),
    );
    const chain: Body[] = [];
    let prev2: Body = ballAnchor;
    // Initial pendulum offset: hang slightly to the right so it has
    // some swing energy when the scene starts.
    const tilt = 0.15;
    for (let i = 0; i < CHAIN_N; i++) {
      const link = world.add(
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
      world.add(
        joint(
          prev2,
          link,
          i === 0 ? { x: 0, y: 0 } : { x: CHAIN_SEG / 2, y: 0 },
          { x: -CHAIN_SEG / 2, y: 0 },
        ),
      );
      prev2 = link;
    }
    const ball = world.add(
      body(
        { size: { w: 40, h: 40 }, density: 4, friction: 0.6 },
        {
          x: ballX + Math.sin(tilt) * (CHAIN_N * CHAIN_SEG + 22),
          y: ballY + Math.cos(tilt) * (CHAIN_N * CHAIN_SEG + 22),
          theta: 0,
        },
      ),
    );
    world.add(
      joint(chain[chain.length - 1]!, ball, { x: CHAIN_SEG / 2, y: 0 }, { x: 0, y: -22 }),
    );

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
    const renderBody = (b: Body, fill: string, cursor = "grab") => {
      const r = s(rect(b.position, b.w, b.h, { fill, corner: 2, thin: true, rotate: b.angle }));
      r.el.style.cursor = cursor;
      const dragging = signal(false);
      dragBody(r, world, b, dragging);
      return r;
    };

    for (let i = 0; i < dynamicBoxes.length; i++) {
      const color = PALETTE[i % PALETTE.length]!;
      renderBody(dynamicBoxes[i]!, color);
    }
    for (const seg of arm) renderBody(seg, "#7a8ba6");
    for (const link of chain) renderBody(link, "#665");
    renderBody(ball, "#3a3a3a");

    this.anim.start(world.animate());

    s(
      label(
        view.top.down(14),
        "drag any body — pyramid stacks, IK arm articulates, wrecking ball swings",
        { size: 12, align: Anchor.Center, opacity: 0.7 },
      ),
      label(
        view.bottom.up(16),
        `${dynamicBoxes.length} stack · ${arm.length}-bar IK arm · ${chain.length}-link chain + ball · diag(m, m, I) cells · SAT + Coulomb`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
