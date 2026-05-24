// md-particles.ts — non-overlapping circles in a box.
//
// Twenty-four point bodies with two constraint types each:
//   - `inside(P, …)` keeps every particle inside the AABB walls.
//   - `gap(a, b, 2r)` keeps every pair from overlapping.
//
// With mild gravity, the box settles into a
// roughly hexagonal packing. Drag any circle and the rest cascade
// out of the way; release and gravity packs them again. The
// solver is doing 24 wall constraints + 276 pairwise gap
// constraints every frame.

import { animate, gap, inside, physics, pin } from "@minim/constraints";
import {
  Anchor,
  circle,
  Diagram,
  drag,
  label,
  Mount,
  rect,
  signal,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

type WVec = Writable<Vec>;

const N = 24;
const R = 16;
const COLORS = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321", "#9b59b6", "#e74c3c"];

export class MdParticles extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const W = 460;
    const H = 240;
    const xLo = cx - W / 2;
    const xHi = cx + W / 2;
    const yLo = cy - H / 2 + 20;
    const yHi = cy + H / 2 + 20;

    let seed = 11;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    const particles: WVec[] = [];
    for (let i = 0; i < N; i++) {
      particles.push(vec(xLo + R + rand() * (W - 2 * R), yLo + R + rand() * (H * 0.4)));
    }

    const cluster = physics({ iterations: 14, gravity: [0, 320], damping: 0.99 });
    for (const p of particles) cluster.add(inside(p, xLo + R, yLo + R, xHi - R, yHi - R));
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) cluster.add(gap(particles[i]!, particles[j]!, 2 * R));
    }

    s(rect(xLo, yLo, W, H, { thin: true, opacity: 0.4, corner: 6 }));

    for (let i = 0; i < N; i++) {
      const color = COLORS[i % COLORS.length]!;
      const dot = s(circle(particles[i]!, R, { fill: color }));
      dot.el.style.cursor = "grab";
      const dragging = signal(false);
      drag(dot, particles[i]!, dragging);
      cluster.addWhile(dragging, pin(particles[i]!));
    }

    this.anim.start(animate(cluster));

    s(
      label(view.top.down(20), "drag any circle — non-overlap is enforced, walls contain", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        `${N} circles · ${(N * (N - 1)) / 2} pair-gaps · ${N} containments — animated`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
