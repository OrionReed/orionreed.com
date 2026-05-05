import {
  Diagram,
  Point,
  Scene,
  annularSector,
  attr,
  circle,
  computed,
  label,
  line,
  pt,
  signal,
  untilSig,
  type Animator,
} from "../scene-v2";
import { grey, ink, stroke } from "./color";
import * as R from "./rand";

type CellState = "received" | "retransmit" | "acknowledged";

const RECEIVE_CHANCE = 0.5;
const RING_OUTER = 150;
const RING_WIDTH_RATIO = 0.2;
const TAU = Math.PI * 2;

const T = {
  broadcastStep: 80,
  beforeFlood: 800,
  floodCellStep: 25,
  afterFlood: 1000,
  betweenCycles: 2000,
  beforeReset: 1000,
  betweenFullCycles: 3000,
};

export class MdQrtpProtocol extends Diagram {
  @attr({ type: "number" }) cells?: number;
  @attr({ type: "boolean" }) backchannel?: boolean;

  protected setup(s: Scene): void {
    const N = this.cells ?? 60;
    const backchannel = this.backchannel ?? false;
    const labelText = this.textContent?.trim() ?? "";

    const rOut = RING_OUTER;
    const rIn = rOut * (1 - RING_WIDTH_RATIO);
    const start = -Math.PI / 2;

    s.view(0, 0, rOut * 2, rOut * 2);
    const center = pt(rOut, rOut);

    // ── State ───────────────────────────────────────────────────────

    const cellState = signal<Map<number, CellState>>(new Map());
    const cellOverrides = signal<Map<number, string>>(new Map());
    const broadcastIndex = signal(0);
    const lastBroadcast = signal(-1);

    // Per-cell color: override > broadcast highlight > state-based.
    // Returns null when the cell should be invisible.
    const cellColor = (i: number) => computed((): string | null => {
      const ov = cellOverrides.value.get(i);
      if (ov !== undefined) return ov;
      if (i === lastBroadcast.value) return stroke.toString();
      const st = cellState.value.get(i);
      if (st === "received") return ink("green").mod(0.7).toString();
      if (st === "retransmit") return ink("orange").mod(0.7).toString();
      if (st === "acknowledged") return grey.mod(0.7).toString();
      return null;
    });
    const colors = Array.from({ length: N }, (_, i) => cellColor(i));

    // ── Render ──────────────────────────────────────────────────────

    // Cell sectors first (filled), then outline circles + radial dividers
    // on top so seams between sectors stay clean.
    for (let i = 0; i < N; i++) {
      const a0 = start + (i * TAU) / N;
      const a1 = a0 + TAU / N;
      s(annularSector(center, rOut, rIn, a0, a1, {
        stroke: "none",
        fill: () => colors[i].value ?? "transparent",
        opacity: () => colors[i].value === null ? 0 : 1,
      }));
    }

    s(circle(center, rOut, { thin: true }));
    s(circle(center, rIn, { thin: true }));
    for (let i = 0; i < N; i++) {
      const a = start + (i * TAU) / N;
      s(line(Point.polar(center, rIn, a), Point.polar(center, rOut, a), { thin: true }));
    }

    if (labelText) s(label(center, labelText, { bold: true }));

    // ── Helpers ─────────────────────────────────────────────────────

    const cellsWithState = (st: CellState): number[] => {
      const out: number[] = [];
      for (const [i, v] of cellState.peek()) if (v === st) out.push(i);
      return out;
    };

    const buildComponents = (): number[][] => {
      const visited = new Set<number>();
      const components: number[][] = [];
      for (const seed of cellsWithState("retransmit")) {
        if (visited.has(seed)) continue;
        const component: number[] = [];
        const queue = [seed];
        while (queue.length > 0) {
          const c = queue.shift()!;
          if (visited.has(c)) continue;
          visited.add(c);
          component.push(c);
          for (const nb of [(c - 1 + N) % N, (c + 1) % N]) {
            // Flood crosses any received-once neighbor (incl. acknowledged).
            if (!visited.has(nb) && cellState.peek().has(nb)) queue.push(nb);
          }
        }
        if (component.length > 0) components.push(component);
      }
      return components;
    };

    const handleReception = (i: number): void => {
      const st = cellState.peek().get(i);
      const next = new Map(cellState.peek());
      if (st === "received") {
        if (R.chance(RECEIVE_CHANCE)) next.set(i, "retransmit");
      } else if (st === undefined) {
        if (R.chance(RECEIVE_CHANCE)) next.set(i, "received");
      }
      cellState.value = next;
    };

    const reset = () => {
      cellState.value = new Map();
      cellOverrides.value = new Map();
      broadcastIndex.value = 0;
      lastBroadcast.value = -1;
    };

    // ── Animation ───────────────────────────────────────────────────

    const floodAnim = this.anim.scope();

    function* doFloodFill(): Animator {
      const components = buildComponents();
      const flood = ink("blue").mod(0.7).toString();

      for (const component of components) {
        for (const cell of component) {
          if (cell !== lastBroadcast.peek()) {
            const next = new Map(cellOverrides.peek());
            next.set(cell, flood);
            cellOverrides.value = next;
          }
          yield T.floodCellStep;
        }
      }

      yield T.afterFlood;

      const next = new Map(cellState.peek());
      for (const c of cellsWithState("retransmit")) next.set(c, "received");
      if (backchannel) {
        for (const component of components) {
          for (const c of component) next.set(c, "acknowledged");
        }
      }
      cellState.value = next;
      cellOverrides.value = new Map();
    }

    const startFloodFillLoop = () => {
      floodAnim.loop(function* () {
        yield* untilSig(() => cellsWithState("retransmit").length > 0);
        yield T.beforeFlood;
        yield* doFloodFill();
        yield T.betweenCycles;
      });
    };

    if (backchannel) startFloodFillLoop();

    this.anim.loop(function* () {
      // Skip already-acknowledged cells.
      if (
        backchannel &&
        cellState.peek().get(broadcastIndex.peek()) === "acknowledged"
      ) {
        broadcastIndex.value = (broadcastIndex.peek() + 1) % N;
        return;
      }

      lastBroadcast.value = broadcastIndex.peek();
      handleReception(broadcastIndex.peek());
      broadcastIndex.value = (broadcastIndex.peek() + 1) % N;

      // Full cycle complete — reset and (if backchannel) restart flood.
      if (cellState.peek().size === N) {
        yield T.beforeReset;
        floodAnim.stop();
        reset();
        yield T.betweenFullCycles;
        if (backchannel) startFloodFillLoop();
        return;
      }

      yield T.broadcastStep;
    });
  }
}
