// md-chain.ts — gravity-driven hanging rope.
//
// Internally this is the same machinery as `<md-rigid-rope>`: each
// segment is a 3-DOF rigid body with its own rotational inertia,
// hinged to the next via a revolute `Joint`. The visual is a
// continuous polyline through the joint pivots — the rectangles
// are hidden, so the rope reads as a smooth curve while the
// physics keeps the per-bar angular inertia that makes a chain
// feel like a chain (rather than a sequence of beads on a string,
// which is what a point-mass + distance-constraint rope gives you).
//
// What's the difference between the two approaches?
//   - Point masses (Vec, dim=2): each node has only x, y. Distance
//     constraints connect them. The chain has no rotational state
//     per segment — bending energy is zero, swinging feels like
//     beads.
//   - Rigid bars (3-DOF cell): each link has x, y, θ AND moment of
//     inertia. Rotating a bar takes torque (gravity acting on the
//     COM of an off-center bar produces a moment). The chain
//     rotates segment by segment with realistic angular momentum.
//
// Both render fine as a single line. Same `Joint` force; same
// `Simulation`; same Cluster. The 3-DOF cell is the difference.

import { type Body, RigidWorld } from "@minim/constraints";
import {
  type AnyShape,
  Anchor,
  circle,
  Diagram,
  drive,
  effect,
  label,
  Mount,
  Path,
  type Signal,
  signal,
  Vec,
  type Writable,
} from "../../minim";

const N = 28;
const LINK_W = 12;
const LINK_H = 4;

function findSvgRoot(el: Element | null): SVGSVGElement | null {
  let walker: Element | null = el;
  while (walker) {
    if (walker.tagName === "svg") return walker as SVGSVGElement;
    walker = walker.parentElement;
  }
  return null;
}

function dragWorld(shape: AnyShape, target: Writable<Vec>, dragging: Signal<boolean>): () => void {
  const root = findSvgRoot(shape.el);
  const toWorld = (clientX: number, clientY: number) => {
    const ctm = root?.getScreenCTM()?.inverse();
    if (!ctm) return { x: 0, y: 0 };
    return {
      x: clientX * ctm.a + clientY * ctm.c + ctm.e,
      y: clientX * ctm.b + clientY * ctm.d + ctm.f,
    };
  };
  let pid = -1;
  let dx = 0;
  let dy = 0;
  const offDown = shape.on("pointerdown", e => {
    const pe = e as PointerEvent;
    const w = toWorld(pe.clientX, pe.clientY);
    const v = target.value;
    dx = w.x - v.x;
    dy = w.y - v.y;
    pid = pe.pointerId;
    shape.el.setPointerCapture(pid);
    (dragging as Writable<typeof dragging>).value = true;
  });
  const offMove = shape.on("pointermove", e => {
    if (pid === -1) return;
    const pe = e as PointerEvent;
    const w = toWorld(pe.clientX, pe.clientY);
    target.value = { x: w.x - dx, y: w.y - dy };
  });
  const stop = () => {
    if (pid !== -1) {
      try {
        shape.el.releasePointerCapture(pid);
      } catch {
        /* fine */
      }
      pid = -1;
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

export class MdChain extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const anchorX = view.left.right(60).value.x;
    const anchorY = view.top.down(40).value.y;

    const world = new RigidWorld({
      gravity: [0, 1500],
      iterations: 14,
      postStabilize: true,
      damping: 1,
      maxAngularSpeed: 100,
    });

    const anchor = world.add(
      { size: { w: 8, h: 8 }, density: 0 },
      { x: anchorX, y: anchorY },
    );
    s(circle(anchor.position, 5, { fill: true }));

    const links: Body[] = [];
    let prev = anchor;
    for (let i = 0; i < N; i++) {
      const cx = anchorX + LINK_W / 2 + i * LINK_W;
      const link = world.add(
        { size: { w: LINK_W - 0.5, h: LINK_H }, density: 1, friction: 0.4 },
        { x: cx, y: anchorY },
      );
      links.push(link);
      world.joint(
        prev,
        link,
        i === 0 ? { x: 0, y: 0 } : { x: LINK_W / 2, y: 0 },
        { x: -LINK_W / 2, y: 0 },
      );
      prev = link;
    }

    // Render the rope as a continuous polyline through joint pivots
    // — anchor pivot, then each link's left-end pivot, then the
    // last link's right end. Each pivot is a `Vec.lens` derived
    // from the body's pose, so the path tracks the rigid-bar
    // physics every frame.
    const pivots: Vec[] = [anchor.position];
    for (const link of links) {
      pivots.push(
        Vec.lens(
          () => {
            const c = Math.cos(link.angle.value);
            const sn = Math.sin(link.angle.value);
            const p = link.position.value;
            return { x: p.x + c * (-LINK_W / 2), y: p.y + sn * (-LINK_W / 2) };
          },
          () => {},
        ),
      );
    }
    const tipBody = links[links.length - 1]!;
    const tipPos = Vec.lens(
      () => {
        const c = Math.cos(tipBody.angle.value);
        const sn = Math.sin(tipBody.angle.value);
        const p = tipBody.position.value;
        return { x: p.x + c * (LINK_W / 2), y: p.y + sn * (LINK_W / 2) };
      },
      () => {},
    );
    pivots.push(tipPos);
    s(new Path(pivots, { thin: false }));

    const tipHandle = s(circle(tipPos, 6, { fill: "#5b8def" }));
    tipHandle.el.style.cursor = "grab";
    const dragging = signal(false);
    dragWorld(tipHandle, tipBody.position as Writable<Vec>, dragging);
    let release: (() => void) | undefined;
    effect(() => {
      if (dragging.value) {
        release = tipBody.pin();
      } else if (release) {
        release();
        release = undefined;
      }
    });
    effect(() => {
      if (!dragging.value) return;
      const p = tipBody.position.value;
      const off = world.cluster.solver.offsets[tipBody.cellId]!;
      world.cluster.solver.positions[off]! = p.x;
      world.cluster.solver.positions[off + 1]! = p.y;
    });

    // Mid-rope handle so the user can grab the rope by the middle too.
    const midIdx = (links.length / 2) | 0;
    const midBody = links[midIdx]!;
    const midHandle = s(circle(midBody.position, 5, { fill: "#e25c5c" }));
    midHandle.el.style.cursor = "grab";
    const midDragging = signal(false);
    dragWorld(midHandle, midBody.position as Writable<Vec>, midDragging);
    let midRelease: (() => void) | undefined;
    effect(() => {
      if (midDragging.value) {
        midRelease = midBody.pin();
      } else if (midRelease) {
        midRelease();
        midRelease = undefined;
      }
    });
    effect(() => {
      if (!midDragging.value) return;
      const p = midBody.position.value;
      const off = world.cluster.solver.offsets[midBody.cellId]!;
      world.cluster.solver.positions[off]! = p.x;
      world.cluster.solver.positions[off + 1]! = p.y;
    });

    this.anim.start(drive(tick => world.step(tick.dt)));

    s(
      label(view.top.down(20), "drag the blue tip or the red mid-link — gravity carries the rest", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        `${N} rigid bars (3-DOF cells) · ${N} revolute joints · rendered as a polyline`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
