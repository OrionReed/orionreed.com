// md-rigid-rope.ts — chain made of rigid bars linked by revolute joints.
//
// AVBD's reference 2D demo (`sceneRope`) builds rope this way: each
// link is a small rigid body with its own pose and inertia, hinged
// to the next via a `Joint` with hard position rows and zero angle
// stiffness. Drag any link to lead; the rest swings under gravity.
// Compared to the point-mass + distance-constraint chain, this one
// has rotational inertia per link — bars feel like bars, not beads.

import { type Body, RigidWorld } from "@minim/constraints";
import {
  Anchor,
  type AnyShape,
  circle,
  Diagram,
  drive,
  effect,
  label,
  Mount,
  rect,
  type Signal,
  signal,
  Vec,
  type Writable,
} from "../../minim";

const N = 18;
const LINK_W = 18;
const LINK_H = 6;

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
  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
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

export class MdRigidRope extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 420);
    const anchorX = view.center.value.x;
    const anchorY = view.top.down(40).value.y;

    const world = new RigidWorld({
      gravity: [0, 1500],
      iterations: 14,
      postStabilize: true,
      damping: 1,
      maxAngularSpeed: 100,
    });

    // Static anchor block.
    const anchor = world.add({ size: { w: 8, h: 8 }, density: 0 }, { x: anchorX, y: anchorY });
    s(rect(anchor.position, 10, 10, { fill: "#222" }));

    // Link bodies, one after another.
    const links: Body[] = [];
    let prev = anchor;
    for (let i = 0; i < N; i++) {
      const cx = anchorX + LINK_W / 2 + i * LINK_W;
      const link = world.add(
        { size: { w: LINK_W - 1, h: LINK_H }, density: 1, friction: 0.5 },
        { x: cx, y: anchorY, theta: 0 },
      );
      links.push(link);
      const rA = i === 0 ? { x: 0, y: 0 } : { x: LINK_W / 2, y: 0 };
      const rB = { x: -LINK_W / 2, y: 0 };
      world.joint(prev, link, rA, rB);
      prev = link;
    }

    // Render each link as a rotated rect bound to the body's pose.
    const PALETTE = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321"];
    for (let i = 0; i < links.length; i++) {
      const link = links[i]!;
      const r = s(
        rect(link.position, LINK_W - 1, LINK_H, {
          fill: PALETTE[i % PALETTE.length]!,
          corner: 1,
        }),
      );
      effect(() => {
        r.rotate.value = link.angle.value;
      });
      r.el.style.cursor = "grab";

      // World-frame drag → pin during drag → push user value into solver.
      const dragging = signal(false);
      dragWorld(r, link.position as Writable<Vec>, dragging);
      let release: (() => void) | undefined;
      effect(() => {
        if (dragging.value) {
          release = link.pin();
        } else if (release) {
          release();
          release = undefined;
        }
      });
      effect(() => {
        if (!dragging.value) return;
        const p = link.position.value;
        const off = world.constraints.solver.offsets[link.cellId]!;
        world.constraints.solver.positions[off]! = p.x;
        world.constraints.solver.positions[off + 1]! = p.y;
      });
    }

    // Show joint pivots as small dots.
    for (let i = 0; i < links.length; i++) {
      const link = links[i]!;
      const pivot = Vec.lens(
        () => {
          const c = Math.cos(link.angle.value);
          const sn = Math.sin(link.angle.value);
          const p = link.position.value;
          return { x: p.x + c * (-LINK_W / 2) - sn * 0, y: p.y + sn * (-LINK_W / 2) + c * 0 };
        },
        () => {},
      );
      s(circle(pivot, 1.6, { fill: "#fff", thin: true }));
    }

    this.anim.start(drive(tick => world.step(tick.dt)));

    s(
      label(
        view.top.down(20),
        "drag any link — rigid bars + revolute joints, full rotation per link",
        {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        },
      ),
      label(
        view.bottom.up(16),
        `${N} rigid bars · ${N} joints · diag(m, m, I) per body · postStabilize`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
