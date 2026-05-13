import {
  Diagram,
  Mount,
  annularSector,
  attr,
  cell,
  circle,
  derive,
  label,
  line,
  loop,
  polar,
  snapshot,
  when,
  type Animator,
  type Cell,
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
  @attr.num(60) declare cells: Cell<number>;
  @attr.bool() declare backchannel: Cell<boolean>;

  protected scene(s: Mount): void {
    const N = this.cells.value;
    const backchannel = this.backchannel.value;
    const labelText = this.textContent?.trim() ?? "";

    const rOut = RING_OUTER;
    const rIn = rOut * (1 - RING_WIDTH_RATIO);
    const start = -Math.PI / 2;

    const view = this.view(rOut * 2, rOut * 2);
    const center = view.center;

    // ── State ───────────────────────────────────────────────────────
    // Plain record of signals — `state.cells.value` etc. for both read
    // and write. `snapshot(state)` flattens all signal-valued
    // properties for one-call reset.
    const state = {
      cells: cell(new Map<number, CellState>()),
      overrides: cell(new Map<number, string>()),
      broadcast: cell(0),
      lastBroadcast: cell(-1),
    };

    // Per-cell color: override > broadcast highlight > state-based.
    // Returns null when the cell should be invisible.
    const cellColor = (i: number) =>
      cell.derived((): string | null => {
        const ov = state.overrides.value.get(i);
        if (ov !== undefined) return ov;
        if (i === state.lastBroadcast.value) return stroke.toString();
        const st = state.cells.value.get(i);
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
          fill: derive(colors[i], (c) => c ?? "transparent"),
          opacity: when(colors[i]),
        }),
      );
    }

    s(
      circle(center, rOut, { thin: true }),
      circle(center, rIn, { thin: true }),
    );
    for (let i = 0; i < N; i++) {
      const a = start + (i * TAU) / N;
      s(
        line(polar(center, rIn, a), polar(center, rOut, a), {
          thin: true,
        }),
      );
    }

    if (labelText) s(label(center, labelText, { bold: true }));

    // ── Helpers ─────────────────────────────────────────────────────

    const cellsWithState = (st: CellState): number[] => {
      const out: number[] = [];
      for (const [i, v] of state.cells.peek()) if (v === st) out.push(i);
      return out;
    };

    const buildComponents = (): number[][] => {
      const cells = state.cells.peek();
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
            if (!visited.has(nb) && cells.has(nb)) queue.push(nb);
          }
        }
        if (component.length > 0) components.push(component);
      }
      return components;
    };

    const handleReception = (i: number): void => {
      const cells = state.cells.peek();
      const st = cells.get(i);
      const next = new Map(cells);
      if (st === "received") {
        if (R.chance(RECEIVE_CHANCE)) next.set(i, "retransmit");
      } else if (st === undefined) {
        if (R.chance(RECEIVE_CHANCE)) next.set(i, "received");
      }
      state.cells.value = next;
    };

    const reset = snapshot(state);

    // ── Animation ───────────────────────────────────────────────────

    // Disposer for the flood-fill loop so we can tear it down between
    // full cycles. Tracked by hand — `anim.loop(...)` returns the
    // disposer, we hold it, and call it on reset.
    let floodDispose: (() => void) | undefined;

    function* doFloodFill(): Animator {
      const components = buildComponents();
      const flood = ink("blue").mod(0.7).toString();

      for (const component of components) {
        for (const cell of component) {
          if (cell !== state.lastBroadcast.peek()) {
            const next = new Map(state.overrides.peek());
            next.set(cell, flood);
            state.overrides.value = next;
          }
          yield T.floodCellStep;
        }
      }

      yield T.afterFlood;

      const next = new Map(state.cells.peek());
      for (const c of cellsWithState("retransmit")) next.set(c, "received");
      if (backchannel) {
        for (const component of components) {
          for (const c of component) next.set(c, "acknowledged");
        }
      }
      state.cells.value = next;
      state.overrides.value = new Map();
    }

    const startFloodFillLoop = () => {
      floodDispose = this.anim.run(loop(function* () {
        while (cellsWithState("retransmit").length === 0) yield;
        yield T.beforeFlood;
        yield* doFloodFill();
        yield T.betweenCycles;
      }));
    };

    if (backchannel) startFloodFillLoop();

    this.anim.run(loop(function* () {
      // Skip already-acknowledged cells.
      if (
        backchannel &&
        state.cells.peek().get(state.broadcast.peek()) === "acknowledged"
      ) {
        state.broadcast.value = (state.broadcast.peek() + 1) % N;
        return;
      }

      state.lastBroadcast.value = state.broadcast.peek();
      handleReception(state.broadcast.peek());
      state.broadcast.value = (state.broadcast.peek() + 1) % N;

      // Full cycle complete — reset and (if backchannel) restart flood.
      if (state.cells.peek().size === N) {
        yield T.beforeReset;
        floodDispose?.();
        floodDispose = undefined;
        reset();
        yield T.betweenFullCycles;
        if (backchannel) startFloodFillLoop();
        return;
      }

      yield T.broadcastStep;
    }));
  }
}
