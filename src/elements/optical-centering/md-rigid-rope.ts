// md-rigid-rope.ts — chain made of rigid bars linked by revolute joints.
//
// AVBD's reference 2D demo (`sceneRope`) builds rope this way: each
// link is a small rigid body with its own pose and inertia, hinged
// to the next via a `Joint` with hard position rows and zero angle
// stiffness. Drag any link to lead; the rest swings under gravity.
// Compared to the point-mass + distance-constraint chain, this one
// has rotational inertia per link — bars feel like bars, not beads.

import { animate, type Body, body, dragBody, joint, world } from "@minim/constraints";
import { circle, Diagram, label, Mount, rect, Vec } from "../../minim";

const N = 18;
const LINK_W = 18;
const LINK_H = 6;

export class MdRigidRope extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 420);
    const anchorX = view.center.value.x;
    const anchorY = view.top.down(40).value.y;

    const w = world({
      gravity: [0, 1500],
      iterations: 14,
      postStabilize: true,
      damping: 1,
      maxAngularSpeed: 100,
    });

    const anchor = w.add(body({ size: { w: 8, h: 8 }, density: 0 }, { x: anchorX, y: anchorY }));
    s(rect(anchor.position, 10, 10, { fill: "#222" }));

    const links: Body[] = [];
    let prev = anchor;
    for (let i = 0; i < N; i++) {
      const cx = anchorX + LINK_W / 2 + i * LINK_W;
      const link = w.add(
        body(
          { size: { w: LINK_W - 1, h: LINK_H }, density: 1, friction: 0.5 },
          { x: cx, y: anchorY, theta: 0 },
        ),
      );
      links.push(link);
      const rA = i === 0 ? { x: 0, y: 0 } : { x: LINK_W / 2, y: 0 };
      const rB = { x: -LINK_W / 2, y: 0 };
      w.add(joint(prev, link, rA, rB));
      prev = link;
    }

    const PALETTE = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321"];
    for (let i = 0; i < links.length; i++) {
      const link = links[i]!;
      const r = s(
        rect(link.position, LINK_W - 1, LINK_H, {
          fill: PALETTE[i % PALETTE.length]!,
          corner: 1,
          rotate: link.angle,
        }),
      );
      dragBody(r, w, link);
    }

    // Joint pivots as small dots — left end of each link in world coords.
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

    this.anim.start(animate(w));

    s(
      label(
        view.top.down(20),
        "drag any link — rigid bars + revolute joints, full rotation per link",
      ),
      label(
        view.bottom.up(16),
        `${N} rigid bars · ${N} joints · diag(m, m, I) per body · postStabilize`,
        { size: 10 },
      ),
    );
  }
}
