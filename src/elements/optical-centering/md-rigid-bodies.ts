// md-rigid-bodies.ts — pseudo-rigid bodies built from distance-linked circles.
//
// Each body is three small circles in an equilateral triangle,
// rigidified by three hard distance constraints (3 cells × 2 DOF
// − 3 sides = 3 DOF, exactly the translation + rotation of a 2D
// rigid body). Cross-body non-overlap is `gap` between every
// cell pair *belonging to different bodies* — intra-body pairs
// keep their distance from the rigid links instead. Walls
// contain each cell. Drop them in under gravity and they tumble,
// stack, and shove each other around like a pile of rocks.

import {
  Anchor,
  circle,
  Diagram,
  drag,
  drive,
  effect,
  label,
  Mount,
  rect,
  signal,
  vec,
  type Vec,
  type Writable,
} from "../../minim";
import { Cluster, distance, gap, inside, Simulation } from "@minim/constraints";

type WVec = Writable<Vec>;

const N_BODIES = 5;
const N_PER_BODY = 3;
const R = 12; // circle radius
const SIDE = 2.4 * R; // triangle side length
const COLORS = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321", "#9b59b6"];

export class MdRigidBodies extends Diagram {
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

    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    const bodies: WVec[][] = [];
    for (let b = 0; b < N_BODIES; b++) {
      const ox = xLo + R * 3 + rand() * (W - R * 6);
      const oy = yLo + R * 3 + rand() * (H * 0.3);
      const phase = rand() * Math.PI * 2;
      const cells: WVec[] = [];
      for (let k = 0; k < N_PER_BODY; k++) {
        const a = phase + (k / N_PER_BODY) * Math.PI * 2;
        cells.push(vec(ox + (SIDE / Math.sqrt(3)) * Math.cos(a), oy + (SIDE / Math.sqrt(3)) * Math.sin(a)));
      }
      bodies.push(cells);
    }

    const cluster = new Cluster({ iterations: 12 });

    // Rigidify each body.
    for (const cells of bodies) {
      for (let i = 0; i < N_PER_BODY; i++) {
        for (let j = i + 1; j < N_PER_BODY; j++) {
          distance(cluster, cells[i]!, cells[j]!, SIDE);
        }
      }
    }

    // Cross-body gap (only between different bodies).
    for (let b1 = 0; b1 < N_BODIES; b1++) {
      for (let b2 = b1 + 1; b2 < N_BODIES; b2++) {
        for (const ci of bodies[b1]!) {
          for (const cj of bodies[b2]!) {
            gap(cluster, ci, cj, 2 * R);
          }
        }
      }
    }

    // Wall containment on every cell.
    for (const cells of bodies) {
      for (const c of cells) inside(cluster, c, xLo + R, yLo + R, xHi - R, yHi - R);
    }

    s(rect(xLo, yLo, W, H, { thin: true, opacity: 0.4, corner: 6 }));

    for (let b = 0; b < N_BODIES; b++) {
      const color = COLORS[b % COLORS.length]!;
      const cells = bodies[b]!;
      for (const cell of cells) {
        const dot = s(circle(cell, R, { fill: color }));
        dot.el.style.cursor = "grab";
        const dragging = signal(false);
        drag(dot, cell, dragging);
        effect(() => (dragging.value ? cluster.pin(cell) : undefined));
      }
    }

    const sim = new Simulation(cluster, { gravity: [0, 280], damping: 0.8 });
    this.anim.start(drive(tick => sim.tick(tick.dt)));

    s(
      label(view.top.down(20), "drag any circle — its body translates and rotates rigidly", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        `${N_BODIES} bodies × 3 circles · 3 rigid links each · cross-body gap · animated`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
