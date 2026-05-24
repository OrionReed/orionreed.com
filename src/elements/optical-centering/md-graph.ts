// md-graph.ts — Fruchterman–Reingold-style force-directed layout.
//
// Four force types per cluster, each pulling its weight from a
// classic graph-layout algorithm:
//
//   - **Spring** along each edge: attraction `F_attr ≈ stiffness·(d − rest)`.
//   - **Repel** between every pair: long-range soft repulsion that's
//     active out to a `RANGE` of ~the diameter of the desired layout.
//     This is the Fruchterman–Reingold `F_rep ≈ k²/d` term — without
//     it, non-edge pairs have nothing pushing them apart and the
//     graph collapses into a clump.
//   - **Gap** between every pair: hard non-overlap (kicks in only
//     when two nodes are about to collide; finishes what the soft
//     repulsion starts).
//   - **softTarget** on every node toward the canvas center: kills
//     the rotational degree of freedom that a single pin otherwise
//     leaves behind, and centers the layout in the viewport.

import { Simulation, constraints, gap, pin, repel, softTarget, spring } from "@minim/constraints";
import {
  Anchor,
  circle,
  Diagram,
  handle,
  label,
  line,
  Mount,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

type WVec = Writable<Vec>;

interface Edge {
  a: number;
  b: number;
}

const EDGES: readonly Edge[] = [
  { a: 0, b: 1 },
  { a: 0, b: 2 },
  { a: 0, b: 3 },
  { a: 1, b: 4 },
  { a: 1, b: 5 },
  { a: 2, b: 6 },
  { a: 2, b: 7 },
  { a: 3, b: 8 },
  { a: 3, b: 9 },
  { a: 4, b: 10 },
  { a: 5, b: 10 },
  { a: 6, b: 11 },
  { a: 7, b: 11 },
  { a: 8, b: 12 },
  { a: 9, b: 12 },
  { a: 10, b: 13 },
  { a: 11, b: 13 },
  { a: 12, b: 13 },
  { a: 13, b: 14 },
  { a: 14, b: 15 },
  { a: 4, b: 6 },
  { a: 5, b: 7 },
  { a: 8, b: 9 },
];
const N = 16;
const REST = 70; // edge spring rest length
const SPRING_K = 600; // edge attraction stiffness — stiff enough to feel taut
const MIN_GAP = 22; // hard non-overlap distance
const REPEL_RANGE = 160; // soft repulsion range — beyond this, no force
const REPEL_K = 30; // soft repulsion stiffness — drives node spread
const CENTER_K = 12;

export class MdGraph extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 400);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const TAU = Math.PI * 2;
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const nodes: WVec[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const r = 70 + rand() * 30;
      nodes.push(vec(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }

    const cluster = constraints({ iterations: 12, postStabilize: true });

    for (const e of EDGES) cluster.add(spring(nodes[e.a]!, nodes[e.b]!, REST, SPRING_K));
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        // Soft long-range repulsion (FR-style) + hard short-range gap.
        cluster.add(repel(nodes[i]!, nodes[j]!, REPEL_RANGE, REPEL_K));
        cluster.add(gap(nodes[i]!, nodes[j]!, MIN_GAP));
      }
    }
    for (let i = 0; i < N; i++) cluster.add(softTarget(nodes[i]!, [cx, cy], CENTER_K));

    // Mild damping — enough energy bleed to settle, not so much
    // that node motion feels viscous. With fast springs and
    // long-range repulsion doing real work, ~5%/frame is plenty.
    const sim = new Simulation(cluster, { damping: 0.95 });
    this.anim.start(sim.animate());

    for (const e of EDGES) s(line(nodes[e.a]!, nodes[e.b]!, { thin: true, opacity: 0.5 }));
    for (let i = 0; i < N; i++)
      s(circle(nodes[i]!, MIN_GAP / 2, { fill: "rgba(91, 141, 239, 0.18)", thin: true }));

    for (let i = 0; i < N; i++) {
      const sig = nodes[i]!;
      const h = s(handle(sig, { r: 6 }));
      cluster.addWhile(h.dragging, pin(sig));
    }

    s(
      label(
        view.top.down(20),
        "drag any node — Fruchterman–Reingold-style: edge springs + long-range repulsion + centering",
        { size: 12, align: Anchor.Center, opacity: 0.7 },
      ),
      label(
        view.bottom.up(16),
        `${N} nodes · ${EDGES.length} springs · ${(N * (N - 1)) / 2} pair repulsions + gaps · centering`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
