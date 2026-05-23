// md-graph.ts — force-directed graph layout via constraints.
//
// Edges are soft springs (attraction at rest length). Every pair
// of nodes gets a hard `gap` constraint (no overlap). The cluster
// is driven by `Simulation` with zero gravity and moderate
// damping — that gives the nodes momentum so the layout has a
// physical "spring it into place" feel rather than the slowly-
// converging snap of a pure static solve.

import { Cluster, gap, Simulation, spring } from "@minim/constraints";
import {
  Anchor,
  circle,
  Diagram,
  drive,
  effect,
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

// Planar-ish small graph: 16 nodes, ~30 edges, mostly tree-ish with
// a few cross-links. Hand-laid so the layout untangles cleanly.
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
const REST = 60;
const MIN_GAP = 30;
const STIFFNESS = 200;

export class MdGraph extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 400);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Initial positions on a perturbed circle so the layout has work to do.
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

    const cluster = new Cluster({ iterations: 12, postStabilize: true });

    for (const e of EDGES) spring(cluster, nodes[e.a]!, nodes[e.b]!, REST, STIFFNESS);
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) gap(cluster, nodes[i]!, nodes[j]!, MIN_GAP);
    }

    // Lightweight centering pin: anchor node 0.
    cluster.pin(nodes[0]!);

    // Simulation with zero gravity and moderate damping: the nodes
    // get momentum (drag and release → it keeps moving briefly) but
    // the layout still settles in a few seconds.
    const sim = new Simulation(cluster, { damping: 0.99 });
    this.anim.start(drive(tick => sim.tick(tick.dt)));

    for (const e of EDGES) s(line(nodes[e.a]!, nodes[e.b]!, { thin: true, opacity: 0.5 }));
    for (let i = 0; i < N; i++)
      s(circle(nodes[i]!, MIN_GAP / 2, { fill: "rgba(91, 141, 239, 0.18)", thin: true }));

    for (let i = 0; i < N; i++) {
      const sig = nodes[i]!;
      const h = s(handle(sig, { r: 6 }));
      effect(() => (h.dragging.value ? cluster.pin(sig) : undefined));
    }

    s(
      label(
        view.top.down(20),
        "drag any node — soft springs along edges, hard gap between every pair",
        {
          size: 12,
          align: Anchor.Center,
          opacity: 0.7,
        },
      ),
      label(
        view.bottom.up(16),
        `${N} nodes · ${EDGES.length} springs · ${(N * (N - 1)) / 2} pairwise gaps`,
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
