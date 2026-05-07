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
  snapshot,
  store,
  until,
  when,
  type Animator,
  type Signal,
} from "../minim";
import { grey, ink, stroke } from "./color";
import * as R from "./rand";

type CellState = "received" | "retransmit" | "acknowledged";

const RECEIVE_CHANCE = 0.5;
const RING_OUTER = 150;
const RING_WIDTH_RATIO = 0.2;
const TAU = Math.PI * 2;

const T = {
  broadcastStep: 0.08,
  beforeFlood: 0.8,
  floodCellStep: 0.025,
  afterFlood: 1,
  betweenCycles: 2,
  beforeReset: 1,
  betweenFullCycles: 3,
};

export class MdQrtpProtocol extends Diagram {
  @attr.num(60) declare cells: Signal<number>;
  @attr.bool() declare backchannel: Signal<boolean>;

  protected scene(s: Scene): void {
    const N = this.cells.value;
    const backchannel = this.backchannel.value;
    const labelText = this.textContent?.trim() ?? "";

    const rOut = RING_OUTER;
    const rIn = rOut * (1 - RING_WIDTH_RATIO);
    const start = -Math.PI / 2;

    s.view(0, 0, rOut * 2, rOut * 2);
    const center = pt(rOut, rOut);

    // ── State ───────────────────────────────────────────────────────
    // All four reactive fields live in one `store` — read with plain
    // property access (tracked inside `computed`, untracked outside),
    // write with assignment, snapshot the whole record at once.
    const state = store({
      cells: new Map<number, CellState>(),
      overrides: new Map<number, string>(),
      broadcast: 0,
      lastBroadcast: -1,
    });

    // Per-cell color: override > broadcast highlight > state-based.
    // Returns null when the cell should be invisible.
    const cellColor = (i: number) =>
      computed((): string | null => {
        const ov = state.overrides.get(i);
        if (ov !== undefined) return ov;
        if (i === state.lastBroadcast) return stroke.toString();
        const st = state.cells.get(i);
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
      s(
        annularSector(center, rOut, rIn, a0, a1, {
          stroke: "none",
          fill: colors[i].derive((c) => c ?? "transparent"),
          opacity: when(colors[i]),
        }),
      );
    }

    s(circle(center, rOut, { thin: true }));
    s(circle(center, rIn, { thin: true }));
    for (let i = 0; i < N; i++) {
      const a = start + (i * TAU) / N;
      s(
        line(Point.polar(center, rIn, a), Point.polar(center, rOut, a), {
          thin: true,
        }),
      );
    }

    if (labelText) s(label(center, labelText, { bold: true }));

    // ── Helpers ─────────────────────────────────────────────────────

    const cellsWithState = (st: CellState): number[] => {
      const out: number[] = [];
      for (const [i, v] of state.cells) if (v === st) out.push(i);
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
            if (!visited.has(nb) && state.cells.has(nb)) queue.push(nb);
          }
        }
        if (component.length > 0) components.push(component);
      }
      return components;
    };

    const handleReception = (i: number): void => {
      const st = state.cells.get(i);
      const next = new Map(state.cells);
      if (st === "received") {
        if (R.chance(RECEIVE_CHANCE)) next.set(i, "retransmit");
      } else if (st === undefined) {
        if (R.chance(RECEIVE_CHANCE)) next.set(i, "received");
      }
      state.cells = next;
    };

    const reset = snapshot(state);

    // ── Animation ───────────────────────────────────────────────────

    const floodAnim = this.anim.scope();

    function* doFloodFill(): Animator {
      const components = buildComponents();
      const flood = ink("blue").mod(0.7).toString();

      for (const component of components) {
        for (const cell of component) {
          if (cell !== state.lastBroadcast) {
            const next = new Map(state.overrides);
            next.set(cell, flood);
            state.overrides = next;
          }
          yield T.floodCellStep;
        }
      }

      yield T.afterFlood;

      const next = new Map(state.cells);
      for (const c of cellsWithState("retransmit")) next.set(c, "received");
      if (backchannel) {
        for (const component of components) {
          for (const c of component) next.set(c, "acknowledged");
        }
      }
      state.cells = next;
      state.overrides = new Map();
    }

    const startFloodFillLoop = () => {
      floodAnim.loop(function* () {
        yield* until(() => cellsWithState("retransmit").length > 0);
        yield T.beforeFlood;
        yield* doFloodFill();
        yield T.betweenCycles;
      });
    };

    if (backchannel) startFloodFillLoop();

    this.anim.loop(function* () {
      // Skip already-acknowledged cells.
      if (backchannel && state.cells.get(state.broadcast) === "acknowledged") {
        state.broadcast = (state.broadcast + 1) % N;
        return;
      }

      state.lastBroadcast = state.broadcast;
      handleReception(state.broadcast);
      state.broadcast = (state.broadcast + 1) % N;

      // Full cycle complete — reset and (if backchannel) restart flood.
      if (state.cells.size === N) {
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
