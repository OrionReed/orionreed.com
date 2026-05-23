// md-cloth.ts — gravity-driven cloth simulation.
//
// 14×10 grid of point masses linked by horizontal and vertical
// distance constraints (no diagonals — keeps the cloth soft).
// Top corners are pinned. Drag any node and it leads while the
// rest reflows under gravity. The constraint engine handles
// ~250 hard constraints and an animated `Simulation` time-step
// at 60 fps.

import {
  Anchor,
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

const W = 14;
const H = 10;
const SP = 26;

export class MdCloth extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const top = view.top.value.y + 28;

    const grid: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) {
        row.push(vec(cx - ((W - 1) * SP) / 2 + i * SP, top + j * SP));
      }
      grid.push(row);
    }

    const cluster = new Cluster({ iterations: 8 });

    for (let j = 0; j < H; j++) {
      for (let i = 1; i < W; i++) distance(cluster, grid[j]![i - 1]!, grid[j]![i]!, SP);
    }
    for (let i = 0; i < W; i++) {
      for (let j = 1; j < H; j++) distance(cluster, grid[j - 1]![i]!, grid[j]![i]!, SP);
    }

    cluster.pin(grid[0]![0]!);
    cluster.pin(grid[0]![W - 1]!);

    // Render edges as Lines (cheap reactive bindings) so the cloth
    // updates whenever the underlying signals change.
    for (let j = 0; j < H; j++) {
      for (let i = 1; i < W; i++) s(line(grid[j]![i - 1]!, grid[j]![i]!, { thin: true, opacity: 0.55 }));
    }
    for (let i = 0; i < W; i++) {
      for (let j = 1; j < H; j++) s(line(grid[j - 1]![i]!, grid[j]![i]!, { thin: true, opacity: 0.55 }));
    }

    // One handle per node — every node is draggable.
    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>]> = grid
      .flat()
      .map(sig => [sig, s(handle(sig, { r: 3 }))] as const);
    for (const [sig, h] of handles) {
      effect(() => (h.dragging.value ? cluster.pin(sig) : undefined));
    }

    const sim = new Simulation(cluster, { gravity: [0, 120] });
    this.anim.start(drive(tick => sim.tick(Math.min(tick.dt, 1 / 30))));

    s(
      label(view.bottom.up(16), `${W}×${H} grid · ${(W - 1) * H + W * (H - 1)} hard distance constraints · 60 fps`, {
        size: 10,
        align: Anchor.Center,
        opacity: 0.5,
      }),
    );
  }
}
