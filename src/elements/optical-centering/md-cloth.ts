// md-cloth.ts — gravity-driven cloth simulation.
//
// 14×10 grid of point masses with three force types:
//   - horizontal + vertical edge springs (stretching resistance)
//   - 3-point `bend`s along rows and columns (bending resistance)
//
// `postStabilize` runs the AVBD paper's recommended physics
// loop: regular iters with α=1 (drift-tolerant), then one final
// α=0 iter to zero the residual at frame end. Adaptive warm-start
// (default-on when gravity is present) attenuates the gravity
// term in the position seed for cells that are being supported
// by their constraints, killing the residual jitter that
// supported bodies otherwise produce.

import { bend, constraints, Simulation, Strength, spring } from "@minim/constraints";
import {
  Anchor,
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

    const cluster = constraints({ iterations: 12, postStabilize: true });

    // Edge springs — resist stretching.
    for (let j = 0; j < H; j++) {
      for (let i = 1; i < W; i++)
        cluster.add(spring(grid[j]![i - 1]!, grid[j]![i]!, SP, Strength.MEDIUM));
    }
    for (let i = 0; i < W; i++) {
      for (let j = 1; j < H; j++)
        cluster.add(spring(grid[j - 1]![i]!, grid[j]![i]!, SP, Strength.MEDIUM));
    }

    // 3-point bends — resist folding (the missing piece for cloth-like drape).
    for (let j = 0; j < H; j++) {
      for (let i = 2; i < W; i++)
        cluster.add(bend(grid[j]![i - 2]!, grid[j]![i - 1]!, grid[j]![i]!, 0.5));
    }
    for (let i = 0; i < W; i++) {
      for (let j = 2; j < H; j++)
        cluster.add(bend(grid[j - 2]![i]!, grid[j - 1]![i]!, grid[j]![i]!, 0.5));
    }

    cluster.pin(grid[0]![0]!);
    cluster.pin(grid[0]![W - 1]!);

    // Render edges as Lines (cheap reactive bindings) so the cloth
    // updates whenever the underlying signals change.
    for (let j = 0; j < H; j++) {
      for (let i = 1; i < W; i++)
        s(line(grid[j]![i - 1]!, grid[j]![i]!, { thin: true, opacity: 0.55 }));
    }
    for (let i = 0; i < W; i++) {
      for (let j = 1; j < H; j++)
        s(line(grid[j - 1]![i]!, grid[j]![i]!, { thin: true, opacity: 0.55 }));
    }

    // One handle per node — every node is draggable.
    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>]> = grid
      .flat()
      .map(sig => [sig, s(handle(sig, { r: 3 }))] as const);
    for (const [sig, h] of handles) {
      effect(() => (h.dragging.value ? cluster.pin(sig) : undefined));
    }

    // post-stabilization + adaptive warm-start absorb most of the
    // energy through constraint drift, so we can run with very
    // light damping — the cloth feels alive instead of underwater.
    const sim = new Simulation(cluster, { gravity: [0, 90], damping: 0.997 });
    this.anim.start(drive(tick => sim.tick(tick.dt)));

    s(
      label(
        view.bottom.up(16),
        `${W}×${H} grid · ${(W - 1) * H + W * (H - 1)} stiff springs · 60 fps`,
        {
          size: 10,
          align: Anchor.Center,
          opacity: 0.5,
        },
      ),
    );
  }
}
