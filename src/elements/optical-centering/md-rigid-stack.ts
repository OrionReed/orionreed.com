// md-rigid-stack.ts — classic rigid-body stack.
//
// Boxes with full 3-DOF pose (x, y, θ), diagonal mass `(m, m, I)`,
// and a per-frame SAT broadphase generating `BoxContact` manifolds
// with normal + tangential rows (Coulomb friction). Static walls
// + ground; dynamic stack falls and settles. Drag any box to
// throw it around — pin during drag, release lets gravity do its
// thing.

import {
  Anchor,
  Diagram,
  drag,
  drive,
  effect,
  label,
  line,
  Mount,
  rect,
  signal,
  vec,
  type Vec,
  type Writable,
} from "../../minim";
import { type Body, RigidWorld } from "@minim/constraints";

const PALETTE = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321", "#9b59b6", "#1abc9c"];

export class MdRigidStack extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 400);
    const cx = view.center.value.x;
    const floorY = view.bottom.up(40).value.y;
    const wallL = view.left.right(40).value.x;
    const wallR = view.right.left(40).value.x;

    const world = new RigidWorld({
      gravity: [0, 1500],
      iterations: 14,
      postStabilize: true,
      damping: 0.995,
    });

    // Static walls and ground.
    const ground = world.add({ size: { w: wallR - wallL + 80, h: 16 }, density: 0, friction: 0.7 }, { x: cx, y: floorY + 8 });
    const leftWall = world.add({ size: { w: 16, h: 320 }, density: 0, friction: 0.5 }, { x: wallL - 8, y: floorY - 160 });
    const rightWall = world.add({ size: { w: 16, h: 320 }, density: 0, friction: 0.5 }, { x: wallR + 8, y: floorY - 160 });

    // A small pyramid: row 0 has 4 boxes, row 1 has 3, row 2 has 2, row 3 has 1.
    const SIZE = 44;
    const PYRAMID_BASE = 4;
    const dynamicBoxes: Body[] = [];
    for (let row = 0; row < PYRAMID_BASE; row++) {
      const cols = PYRAMID_BASE - row;
      for (let col = 0; col < cols; col++) {
        const x = cx - ((cols - 1) * SIZE) / 2 + col * SIZE;
        const y = floorY - 8 - SIZE / 2 - row * (SIZE + 1);
        const b = world.add(
          { size: { w: SIZE - 2, h: SIZE - 2 }, density: 1, friction: 0.5 },
          { x, y, theta: 0 },
        );
        dynamicBoxes.push(b);
      }
    }

    // One taller free body for variety.
    const slab = world.add({ size: { w: 90, h: 18 }, density: 0.8, friction: 0.4 }, { x: cx, y: floorY - 320 });
    dynamicBoxes.push(slab);

    // Render walls/ground (static — non-reactive position is fine).
    s(rect(wallL - 16, floorY, wallR - wallL + 32, 16, { fill: "rgba(120, 120, 120, 0.5)", thin: true }));
    s(rect(wallL - 16, floorY - 320, 16, 320, { fill: "rgba(120, 120, 120, 0.3)", thin: true }));
    s(rect(wallR, floorY - 320, 16, 320, { fill: "rgba(120, 120, 120, 0.3)", thin: true }));
    void ground;
    void leftWall;
    void rightWall;

    // Render dynamic boxes — each rect's `center` and `rotate` bind
    // to the body's reactive position/angle signals, so the shape
    // tracks the solver every frame.
    for (let i = 0; i < dynamicBoxes.length; i++) {
      const b = dynamicBoxes[i]!;
      const color = PALETTE[i % PALETTE.length]!;
      const r = s(rect(b.position, b.w, b.h, { fill: color, corner: 2, thin: true }));
      r.rotate.value = b.angle.value;
      effect(() => {
        r.rotate.value = b.angle.value;
      });
      r.el.style.cursor = "grab";

      // Drag: write to the body's position signal AND pin during drag
      // so the solver respects the user's value.
      const dragging = signal(false);
      drag(r, b.position as Writable<Vec>, dragging);
      let release: (() => void) | undefined;
      effect(() => {
        if (dragging.value) {
          release = b.pin();
        } else if (release) {
          release();
          release = undefined;
        }
      });
      // While dragging, the user writes to b.position (Vec). The solver
      // reads from its own SOA buffer. Push the dragged values back into
      // the solver before each step so the constraint solve sees them.
      effect(() => {
        if (!dragging.value) return;
        const p = b.position.value;
        const off = world.cluster.solver.offsets[b.cellId]!;
        world.cluster.solver.positions[off]! = p.x;
        world.cluster.solver.positions[off + 1]! = p.y;
      });
    }

    this.anim.start(drive(tick => world.step(tick.dt)));

    s(
      label(
        view.top.down(20),
        "drag any box — full 2D rigid-body sim with contacts, friction, stacking",
        { size: 12, align: Anchor.Center, opacity: 0.7 },
      ),
      label(
        view.bottom.up(16),
        `${dynamicBoxes.length} dynamic + 3 static · diag(m, m, I) cells · SAT contacts · Coulomb friction`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
    void line;
  }
}
