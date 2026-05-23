// md-chain.ts — gravity-driven hanging chain.
//
// 40 point masses linked by hard distance constraints, anchored
// at one end. The free tail swings under gravity; drag any node
// to lead. With each link a unit hard constraint and a `Simulation`
// time-step, the chain behaves like a physical rope.

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
  vec,
  type Vec,
  type Writable,
} from "../../minim";
import { Cluster, distance, Simulation } from "@minim/constraints";

type WVec = Writable<Vec>;

const N = 40;
const LINK = 12;

export class MdChain extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const anchor = vec(view.left.right(50).value.x, view.top.down(40).value.y);

    const links: WVec[] = [anchor];
    for (let i = 1; i < N; i++) {
      links.push(vec(anchor.value.x + i * LINK, anchor.value.y));
    }

    const cluster = new Cluster({ iterations: 12 });
    for (let i = 1; i < N; i++) distance(cluster, links[i - 1]!, links[i]!, LINK);
    cluster.pin(anchor);

    for (let i = 1; i < N; i++) s(line(links[i - 1]!, links[i]!, { thin: true }));
    s(circle(anchor, 5, { fill: true }));

    const tipHandle = s(handle(links[N - 1]!, { fill: "#5b8def", r: 7 }));
    effect(() => (tipHandle.dragging.value ? cluster.pin(links[N - 1]!) : undefined));

    // Mid-chain handle so the user can grab the rope by the middle.
    const midIdx = (N / 2) | 0;
    const midHandle = s(handle(links[midIdx]!, { fill: "#e25c5c", r: 6 }));
    effect(() => (midHandle.dragging.value ? cluster.pin(links[midIdx]!) : undefined));

    const sim = new Simulation(cluster, { gravity: [0, 220] });
    this.anim.start(drive(tick => sim.tick(Math.min(tick.dt, 1 / 30))));

    s(
      label(view.top.down(20), "drag the blue tip or the red mid-link — gravity pulls the rest", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(view.bottom.up(16), `${N}-link rope · ${N - 1} hard distance constraints · animated`, {
        size: 10,
        align: Anchor.Center,
        opacity: 0.5,
      }),
    );
  }
}
