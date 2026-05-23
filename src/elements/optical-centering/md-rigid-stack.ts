// md-rigid-stack.ts — classic rigid-body stack.
//
// Boxes with full 3-DOF pose (x, y, θ), diagonal mass `(m, m, I)`,
// and a per-frame SAT broadphase generating `BoxContact` manifolds
// with normal + tangential rows (Coulomb friction). Static walls
// + ground; dynamic stack falls and settles. Drag any box to
// throw it around — pin during drag, release lets gravity do its
// thing.
//
// Uses a custom `dragWorld` helper rather than the stock `drag()`:
// `shape.toLocal()` returns coordinates in the shape's *intrinsic*
// frame, which for a rotating rigid-body rect is itself rotating —
// so feeding those values back into the world-frame body position
// produces a teleporting box. Reading client coordinates through
// the SVG root's CTM gives stable world-frame coords regardless
// of how the rect is transformed.

import {
  type AnyShape,
  Anchor,
  Diagram,
  drive,
  effect,
  label,
  Mount,
  rect,
  type Signal,
  signal,
  type Vec,
  type Writable,
} from "../../minim";
import { type Body, RigidWorld } from "@minim/constraints";

function findSvgRoot(el: Element | null): SVGSVGElement | null {
  let walker: Element | null = el;
  while (walker) {
    if (walker.tagName === "svg") return walker as SVGSVGElement;
    walker = walker.parentElement;
  }
  return null;
}

/** Drag a shape and write the cursor (in the SVG root's frame) into
 *  `target`. Unlike the default `drag()`, this never goes through
 *  `shape.toLocal()` — works correctly even when the dragged shape
 *  has a rotation transform. */
function dragWorld(shape: AnyShape, target: Writable<Vec>, dragging: Signal<boolean>): () => void {
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
  const offDown = shape.on("pointerdown", e => {
    const pe = e as PointerEvent;
    const w = toWorld(pe.clientX, pe.clientY);
    const v = target.value;
    dx = w.x - v.x;
    dy = w.y - v.y;
    pointerId = pe.pointerId;
    shape.el.setPointerCapture(pointerId);
    (dragging as Writable<typeof dragging>).value = true;
  });
  const offMove = shape.on("pointermove", e => {
    if (pointerId === -1) return;
    const pe = e as PointerEvent;
    const w = toWorld(pe.clientX, pe.clientY);
    target.value = { x: w.x - dx, y: w.y - dy };
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
    const view = this.view(640, 400);
    const cx = view.center.value.x;
    const floorY = view.bottom.up(40).value.y;
    const wallL = view.left.right(40).value.x;
    const wallR = view.right.left(40).value.x;

    const world = new RigidWorld({
      gravity: [0, 1500],
      iterations: 14,
      postStabilize: true,
      // The augmented Lagrangian with post-stabilization absorbs
      // enough energy through constraint drift that no explicit
      // velocity damping is needed for a stable stack.
      damping: 1,
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

      // World-frame drag (avoids shape.toLocal's rotated-frame trap).
      const dragging = signal(false);
      dragWorld(r, b.position as Writable<Vec>, dragging);
      let release: (() => void) | undefined;
      effect(() => {
        if (dragging.value) {
          release = b.pin();
        } else if (release) {
          release();
          release = undefined;
        }
      });
      // While dragging, push the user's write into the solver buffer
      // so the constraint solve sees the new position immediately.
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
  }
}
